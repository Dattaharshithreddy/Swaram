package expo.modules.swaramedge

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.NotificationManager
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.Random

private const val N_MELS = 100
private const val HOP = 256

class SynthOptions : Record {
  @Field val duration: Int = 0
  @Field val refFrames: Int = 0
  @Field val cfg: Double = 2.0
  @Field val seed: Double = 0.0
  /** The first `guided` steps use guidance (2 branches); later steps run 1 branch. */
  @Field val guided: Int = Int.MAX_VALUE
  @Field val progressBase: Int = 0
  @Field val progressTotal: Int = 0
}

class EdgeException(message: String, cause: Throwable? = null) :
  CodedException("ERR_SWARAM_EDGE", message, cause)

/**
 * Offline IndicF5 on Android, using ONNX Runtime's official Android library.
 *
 * The four graphs come from edge/swaram_edge/graphs.py. The whole sampling
 * loop runs here (the same algorithm as edge/swaram_edge/runner.py). Audio
 * and mels move between JS and this module as files of float32 values, so
 * no JS memory is touched from the background thread these functions run on.
 *
 * Every stage leaves a line in a trail file before it starts, and the app
 * reads it back after a crash (crashReport) together with Android's own exit
 * record, so a crash on someone's phone says where it happened.
 */
class SwaramEdgeModule : Module() {
  private var env: OrtEnvironment? = null
  private var mel: OrtSession? = null
  private var context: OrtSession? = null
  private var step: OrtSession? = null
  private var vocoder: OrtSession? = null
  private val lock = Any()
  // Personal fast voice (Piper/VITS): its own session and lock.
  private var piper: OrtSession? = null
  private var piperPath: String? = null
  private val piperLock = Any()

  private val appCtx: Context
    get() = appContext.reactContext?.applicationContext ?: throw EdgeException("No Android context")

  private fun trailFile() = File(appCtx.filesDir, "swaram-edge-trail.txt")
  private fun prevTrailFile() = File(appCtx.filesDir, "swaram-edge-trail.prev.txt")
  private fun javaCrashFile() = File(appCtx.filesDir, "swaram-edge-java-crash.txt")

  private fun trail(msg: String) {
    Log.i("SwaramEdge", msg)
    runCatching {
      val ts = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
      val rt = Runtime.getRuntime()
      val heap = (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024)
      trailFile().appendText("$ts $msg (java heap ${heap} MB)\n")
    }
  }

  override fun definition() = ModuleDefinition {
    Name("SwaramEdge")
    Events("onProgress")

    OnCreate {
      runCatching {
        // Keep the previous run's trail for crashReport, start a new one.
        val t = trailFile()
        if (t.exists()) {
          t.copyTo(prevTrailFile(), overwrite = true)
          t.delete()
        }
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        val crashFile = javaCrashFile()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
          runCatching {
            val sw = StringWriter()
            error.printStackTrace(PrintWriter(sw))
            crashFile.writeText("Thread ${thread.name}\n$sw")
          }
          previous?.uncaughtException(thread, error)
        }
      }
    }

    /** Text describing how the app last ended, if that was a crash; else null. Shown once. */
    Function("crashReport") { crashReport() }

    AsyncFunction("load") { dir: String, threads: Int, provider: String ->
      synchronized(lock) {
        releaseSessions()
        val t0 = SystemClock.elapsedRealtime()
        val folder = File(pathOf(dir))
        for (name in listOf("mel.onnx", "context.onnx", "flow.int8.onnx", "vocoder.onnx")) {
          if (!File(folder, name).exists()) throw EdgeException("Missing model file $name. Download the model again.")
        }
        val mem = memoryLine()
        trail("load start provider=$provider threads=$threads $mem")
        try {
          val e = OrtEnvironment.getEnvironment()
          env = e
          fun options(main: Boolean) = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.EXTENDED_OPT)
            setIntraOpNumThreads(threads)
            if (main) {
              when (provider) {
                "nnapi" -> addNnapi()
                "xnnpack" -> addXnnpack(mapOf("intra_op_num_threads" to threads.toString()))
              }
            }
          }
          trail("load mel.onnx")
          mel = e.createSession(File(folder, "mel.onnx").path, options(false))
          trail("load context.onnx")
          context = e.createSession(File(folder, "context.onnx").path, options(false))
          trail("load flow.int8.onnx")
          step = e.createSession(File(folder, "flow.int8.onnx").path, options(true))
          trail("load vocoder.onnx")
          vocoder = e.createSession(File(folder, "vocoder.onnx").path, options(false))
        } catch (t: Throwable) {
          trail("load failed: $t")
          releaseSessions()
          throw EdgeException("Could not load the model: ${t.message}", t)
        }
        trail("load done")
        (SystemClock.elapsedRealtime() - t0).toDouble()
      }
    }

    AsyncFunction("release") {
      synchronized(lock) { releaseSessions() }
    }

    /** wavPath: float32 samples (24 kHz mono). Writes the log-mel (frames x 100) to melPath. Returns frames. */
    AsyncFunction("computeMel") { wavPath: String, melPath: String ->
      synchronized(lock) {
        val e = env ?: throw EdgeException("Model not loaded")
        val session = mel ?: throw EdgeException("Model not loaded")
        try {
          val input = readFloatFile(wavPath)
          trail("mel start samples=${input.size}")
          val frames = OnnxTensor.createTensor(e, FloatBuffer.wrap(input), longArrayOf(1, input.size.toLong())).use { t ->
            session.run(mapOf("wav" to t)).use { res ->
              val tensor = res[0] as OnnxTensor
              val frames = tensor.info.shape[1].toInt()
              val data = FloatArray(frames * N_MELS)
              tensor.floatBuffer.get(data)
              writeFloatFile(melPath, data)
              frames
            }
          }
          trail("mel done frames=$frames")
          frames
        } catch (t: CodedException) {
          throw t
        } catch (t: Throwable) {
          trail("mel failed: $t")
          throw EdgeException("Could not read the recording: ${t.message}", t)
        }
      }
    }

    /**
     * Full generation for one chunk. refMelPath holds the voice's mel
     * (refFrames x 100); the generated audio is written to outPath as
     * float32 samples. Returns timings in ms and the sample count.
     */
    AsyncFunction("synthesize") { ids: List<Int>, refMelPath: String, schedule: List<Double>, outPath: String, opts: SynthOptions ->
      synchronized(lock) {
        try {
          synthesize(ids, refMelPath, schedule, outPath, opts)
        } catch (t: CodedException) {
          throw t
        } catch (t: Throwable) {
          trail("synth failed: $t")
          throw EdgeException("Generation failed: ${t.message}", t)
        }
      }
    }

    /** Loads a personal voice model (once per path). Returns load time in ms. */
    AsyncFunction("piperLoad") { modelPath: String, threads: Int ->
      synchronized(piperLock) {
        val path = pathOf(modelPath)
        if (piper != null && piperPath == path) return@synchronized 0.0
        runCatching { piper?.close() }
        piper = null
        val t0 = SystemClock.elapsedRealtime()
        trail("piper load $path")
        try {
          val e = env ?: OrtEnvironment.getEnvironment().also { env = it }
          val opts = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.EXTENDED_OPT)
            setIntraOpNumThreads(threads)
          }
          piper = e.createSession(path, opts)
          piperPath = path
        } catch (t: Throwable) {
          trail("piper load failed: $t")
          throw EdgeException("Could not load the personal voice: ${t.message}", t)
        }
        (SystemClock.elapsedRealtime() - t0).toDouble()
      }
    }

    /** Phoneme ids -> float32 audio at the model's rate in outPath. Returns samples. */
    AsyncFunction("piperSynth") { ids: List<Int>, noiseScale: Double, lengthScale: Double, noiseW: Double, outPath: String ->
      synchronized(piperLock) {
        val session = piper ?: throw EdgeException("Personal voice not loaded")
        val e = env ?: throw EdgeException("Personal voice not loaded")
        try {
          val idArr = LongArray(ids.size) { ids[it].toLong() }
          val wav = OnnxTensor.createTensor(e, LongBuffer.wrap(idArr), longArrayOf(1, idArr.size.toLong())).use { input ->
            OnnxTensor.createTensor(e, LongBuffer.wrap(longArrayOf(idArr.size.toLong())), longArrayOf(1)).use { lens ->
              OnnxTensor.createTensor(
                e, FloatBuffer.wrap(floatArrayOf(noiseScale.toFloat(), lengthScale.toFloat(), noiseW.toFloat())), longArrayOf(3),
              ).use { scales ->
                session.run(mapOf("input" to input, "input_lengths" to lens, "scales" to scales)).use { r ->
                  val t = r[0] as OnnxTensor
                  val n = t.info.shape.last().toInt()
                  val out = FloatArray(n)
                  t.floatBuffer.get(out)
                  out
                }
              }
            }
          }
          writeFloatFile(outPath, wav)
          wav.size
        } catch (t: Throwable) {
          trail("piper synth failed: $t")
          throw EdgeException("Personal voice failed: ${t.message}", t)
        }
      }
    }

    /** Extracts a zip into destDir. Returns the file names. */
    AsyncFunction("unzip") { zipPath: String, destDir: String ->
      val dest = File(pathOf(destDir)).apply { mkdirs() }
      val names = mutableListOf<String>()
      java.util.zip.ZipInputStream(File(pathOf(zipPath)).inputStream().buffered()).use { zin ->
        while (true) {
          val entry = zin.nextEntry ?: break
          val target = File(dest, entry.name)
          if (!target.canonicalPath.startsWith(dest.canonicalPath + File.separator)) {
            throw EdgeException("Unsafe file name in zip: ${entry.name}")
          }
          if (entry.isDirectory) target.mkdirs() else {
            target.parentFile?.mkdirs()
            target.outputStream().use { zin.copyTo(it) }
            names.add(entry.name)
          }
        }
      }
      names
    }

    /** Writes files (paths) into a zip under the given names. */
    AsyncFunction("zip") { paths: List<String>, names: List<String>, outPath: String ->
      java.util.zip.ZipOutputStream(File(pathOf(outPath)).outputStream().buffered()).use { zout ->
        for ((i, path) in paths.withIndex()) {
          zout.putNextEntry(java.util.zip.ZipEntry(names[i]))
          File(pathOf(path)).inputStream().use { it.copyTo(zout) }
          zout.closeEntry()
        }
      }
      Unit
    }

    /** Any audio file Android can play -> mono float32 at 24 kHz in outPath. Returns samples. */
    AsyncFunction("decodeAudio") { src: String, outPath: String, maxSeconds: Double ->
      try {
        AudioTools.decodeToMono24k(pathOf(src), File(pathOf(outPath)), maxSeconds)
      } catch (t: Throwable) {
        trail("decode failed: $t")
        throw EdgeException("Could not read this audio file: ${t.message}", t)
      }
    }

    /** Joins float32 part files into one 16-bit WAV with short cross-fades. Returns samples. */
    AsyncFunction("joinWav") { parts: List<String>, outPath: String, fadeSamples: Int ->
      AudioTools.joinToWav(parts.map { File(pathOf(it)) }, File(pathOf(outPath)), fadeSamples).toDouble()
    }

    Function("startBackground") { title: String, text: String ->
      val ctx = appCtx
      val intent = Intent(ctx, SwaramWorkService::class.java).putExtra("title", title).putExtra("text", text)
      runCatching {
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
      }.onFailure { trail("background start failed: $it") }.isSuccess
    }

    Function("updateBackground") { title: String, text: String, done: Int, total: Int ->
      val ctx = appCtx
      runCatching {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(SwaramWorkService.NOTIFICATION_ID, SwaramWorkService.build(ctx, title, text, done, total))
      }
      Unit
    }

    Function("stopBackground") {
      val ctx = appCtx
      runCatching { ctx.stopService(Intent(ctx, SwaramWorkService::class.java)) }
      Unit
    }

    /** Android 13+: ask once so the progress notification can show. */
    Function("requestNotifications") {
      if (Build.VERSION.SDK_INT >= 33) {
        val activity = appContext.currentActivity
        if (activity != null && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4207)
        }
      }
      Unit
    }

    OnDestroy {
      synchronized(lock) { releaseSessions() }
      releasePiper()
    }
  }

  private fun synthesize(ids: List<Int>, refMelPath: String, schedule: List<Double>, outPath: String, opts: SynthOptions): Map<String, Any> {
    val e = env ?: throw EdgeException("Model not loaded")
    val ctxSession = context ?: throw EdgeException("Model not loaded")
    val stepSession = step ?: throw EdgeException("Model not loaded")
    val vocSession = vocoder ?: throw EdgeException("Model not loaded")
    val duration = opts.duration
    val refFrames = opts.refFrames
    val steps = schedule.size - 1
    if (refFrames <= 0 || duration <= refFrames || steps < 1) throw EdgeException("Bad generation settings")

    val tokenIds = LongArray(ids.size) { ids[it].toLong() }
    val ts = FloatArray(schedule.size) { schedule[it].toFloat() }
    val refMel = readFloatFile(refMelPath)
    val condData = FloatArray(duration * N_MELS)
    System.arraycopy(refMel, 0, condData, 0, minOf(refMel.size, refFrames * N_MELS))
    val rng = Random(opts.seed.toLong())
    val x = FloatArray(duration * N_MELS) { rng.nextGaussian().toFloat() }
    val frameShape = longArrayOf(1, duration.toLong(), N_MELS.toLong())
    trail("synth start tokens=${ids.size} frames=$duration ref=$refFrames steps=$steps ${memoryLine()}")

    var t0 = SystemClock.elapsedRealtime()
    val ctxResult = OnnxTensor.createTensor(e, LongBuffer.wrap(tokenIds), longArrayOf(1, tokenIds.size.toLong())).use { text ->
      OnnxTensor.createTensor(e, FloatBuffer.wrap(condData), frameShape).use { c ->
        ctxSession.run(mapOf("text" to text, "cond" to c))
      }
    }
    val contextMs = SystemClock.elapsedRealtime() - t0
    trail("synth context done ${contextMs}ms")

    t0 = SystemClock.elapsedRealtime()
    val guided = opts.guided.coerceIn(1, steps)
    val cfg = opts.cfg.toFloat()
    ctxResult.use { cr ->
      val ctx = cr[0] as OnnxTensor
      // Conditioned branch alone, for the unguided late steps (half the work).
      val ctxCond: OnnxTensor? = if (guided < steps) {
        val half = FloatArray(duration * ctx.info.shape[2].toInt())
        ctx.floatBuffer.get(half)
        OnnxTensor.createTensor(e, FloatBuffer.wrap(half), longArrayOf(1, duration.toLong(), ctx.info.shape[2]))
      } else null
      try {
        val n = x.size
        val out = FloatArray(2 * n)
        for (i in 0 until steps) {
          if (i == 0) trail("synth step 1 (guided steps: $guided)")
          val useGuidance = i < guided
          OnnxTensor.createTensor(e, FloatBuffer.wrap(x), frameShape).use { xt ->
            OnnxTensor.createTensor(e, FloatBuffer.wrap(floatArrayOf(ts[i])), longArrayOf(1)).use { tt ->
              val c = if (useGuidance) ctx else ctxCond!!
              stepSession.run(mapOf("x" to xt, "ctx" to c, "t" to tt)).use { r ->
                val buf = (r[0] as OnnxTensor).floatBuffer
                buf.get(out, 0, if (useGuidance) 2 * n else n)
              }
            }
          }
          val dt = ts[i + 1] - ts[i]
          if (useGuidance) {
            for (j in 0 until n) {
              val pred = out[j]
              x[j] += dt * (pred + (pred - out[n + j]) * cfg)
            }
          } else {
            for (j in 0 until n) x[j] += dt * out[j]
          }
          if (i == 0) trail("synth step 1 done")
          sendEvent("onProgress", mapOf("done" to opts.progressBase + i + 1, "total" to opts.progressTotal))
        }
      } finally {
        ctxCond?.close()
      }
    }
    val stepMs = SystemClock.elapsedRealtime() - t0

    // Generated frames only, as (1, mels, frames) for the vocoder.
    trail("synth vocoder")
    t0 = SystemClock.elapsedRealtime()
    val gen = duration - refFrames
    val melT = FloatArray(N_MELS * gen)
    for (f in 0 until gen) {
      val row = (refFrames + f) * N_MELS
      for (m in 0 until N_MELS) melT[m * gen + f] = x[row + m]
    }
    val wav = OnnxTensor.createTensor(e, FloatBuffer.wrap(melT), longArrayOf(1, N_MELS.toLong(), gen.toLong())).use { mt ->
      vocSession.run(mapOf("mel" to mt)).use { r ->
        val t = r[0] as OnnxTensor
        val out = FloatArray(t.info.shape[1].toInt())
        t.floatBuffer.get(out)
        out
      }
    }
    val vocoderMs = SystemClock.elapsedRealtime() - t0
    writeFloatFile(outPath, wav)
    trail("synth done samples=${wav.size}")
    return mapOf(
      "contextMs" to contextMs.toDouble(),
      "stepMs" to stepMs.toDouble(),
      "vocoderMs" to vocoderMs.toDouble(),
      "samples" to wav.size,
    )
  }

  private fun crashReport(): String? {
    val ctx = appCtx
    val prefs = ctx.getSharedPreferences("swaram-edge", Context.MODE_PRIVATE)
    val sb = StringBuilder()
    if (Build.VERSION.SDK_INT >= 30) {
      runCatching {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = am.getHistoricalProcessExitReasons(ctx.packageName, 0, 1).firstOrNull()
        val seen = prefs.getLong("lastExitSeen", 0)
        if (info != null && info.timestamp > seen) {
          prefs.edit().putLong("lastExitSeen", info.timestamp).apply()
          val bad = info.reason in setOf(
            ApplicationExitInfo.REASON_CRASH,
            ApplicationExitInfo.REASON_CRASH_NATIVE,
            ApplicationExitInfo.REASON_ANR,
            ApplicationExitInfo.REASON_LOW_MEMORY,
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
            ApplicationExitInfo.REASON_SIGNALED,
          )
          if (bad) {
            sb.append("Exit: ${reasonName(info.reason)} status=${info.status} pss=${info.pss / 1024}MB rss=${info.rss / 1024}MB\n")
            info.description?.let { sb.append("Description: $it\n") }
            if (info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE || info.reason == ApplicationExitInfo.REASON_ANR) {
              runCatching {
                info.traceInputStream?.use { s -> sb.append(readableStrings(s.readBytes(), 40)) }
              }
            }
          }
        }
      }
    }
    val javaCrash = javaCrashFile()
    if (javaCrash.exists()) {
      sb.append("Java: ").append(javaCrash.readText().lines().take(25).joinToString("\n")).append('\n')
      javaCrash.delete()
    }
    if (sb.isEmpty()) return null
    val prev = prevTrailFile()
    if (prev.exists()) {
      sb.append("Last steps:\n").append(prev.readText().lines().takeLast(12).joinToString("\n"))
    }
    sb.append("\nDevice: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}, ${memoryLine()}")
    return sb.toString()
  }

  private fun memoryLine(): String = runCatching {
    val am = appCtx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    "ram ${mi.totalMem / (1024 * 1024)} MB, free ${mi.availMem / (1024 * 1024)} MB"
  }.getOrDefault("ram ?")

  private fun reasonName(r: Int) = when (r) {
    ApplicationExitInfo.REASON_CRASH -> "crash (java)"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash (native)"
    ApplicationExitInfo.REASON_ANR -> "not responding"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "low memory"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource use"
    ApplicationExitInfo.REASON_SIGNALED -> "signaled"
    else -> "reason $r"
  }

  /** Printable text runs from a tombstone (a protobuf), enough to see the crashing library and frames. */
  private fun readableStrings(bytes: ByteArray, maxLines: Int): String {
    val out = StringBuilder()
    val cur = StringBuilder()
    var lines = 0
    for (b in bytes) {
      val c = b.toInt() and 0xff
      if (c in 0x20..0x7e) cur.append(c.toChar())
      else {
        if (cur.length >= 8 && lines < maxLines) {
          val s = cur.toString()
          if (s.contains(".so") || s.contains("signal") || s.contains("Abort") || s.contains("abort") ||
            s.contains("SIG") || s.contains("Ort") || s.contains("onnx") || s.contains("::") || s.contains("cause")
          ) {
            out.append(s.take(160)).append('\n')
            lines++
          }
        }
        cur.setLength(0)
      }
    }
    return out.toString()
  }

  private fun releasePiper() {
    synchronized(piperLock) {
      runCatching { piper?.close() }
      piper = null
      piperPath = null
    }
  }

  private fun releaseSessions() {
    listOf(mel, context, step, vocoder).forEach { runCatching { it?.close() } }
    mel = null
    context = null
    step = null
    vocoder = null
  }

  private fun pathOf(uriOrPath: String): String =
    if (uriOrPath.startsWith("file:")) Uri.parse(uriOrPath).path ?: uriOrPath.removePrefix("file://") else uriOrPath

  private fun readFloatFile(path: String): FloatArray {
    val bytes = File(pathOf(path)).readBytes()
    val out = FloatArray(bytes.size / 4)
    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out)
    return out
  }

  private fun writeFloatFile(path: String, data: FloatArray) {
    val bytes = ByteArray(data.size * 4)
    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().put(data)
    File(pathOf(path)).writeBytes(bytes)
  }
}
