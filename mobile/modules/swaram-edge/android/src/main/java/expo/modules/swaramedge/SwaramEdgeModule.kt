package expo.modules.swaramedge

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.os.SystemClock
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.typedarray.Float32Array
import expo.modules.kotlin.typedarray.Int32Array
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer

private const val N_MELS = 100

class SynthOptions : Record {
  @Field val duration: Int = 0
  @Field val refFrames: Int = 0
  @Field val cfg: Double = 2.0
  @Field val progressBase: Int = 0
  @Field val progressTotal: Int = 0
  @Field val tokens: Int = 0
  @Field val steps: Int = 0
}

class EdgeException(message: String, cause: Throwable? = null) :
  CodedException("ERR_SWARAM_EDGE", message, cause)

/**
 * Offline IndicF5 on Android, using ONNX Runtime's official Android library.
 *
 * The four graphs come from edge/swaram_edge/graphs.py. The whole sampling
 * loop runs here (the same algorithm as edge/swaram_edge/runner.py), so the
 * large per-sentence context tensor never crosses into JavaScript.
 */
class SwaramEdgeModule : Module() {
  private var env: OrtEnvironment? = null
  private var mel: OrtSession? = null
  private var context: OrtSession? = null
  private var step: OrtSession? = null
  private var vocoder: OrtSession? = null
  private val lock = Any()

  override fun definition() = ModuleDefinition {
    Name("SwaramEdge")
    Events("onProgress")

    AsyncFunction("load") { dir: String, threads: Int, provider: String ->
      synchronized(lock) {
        releaseSessions()
        val t0 = SystemClock.elapsedRealtime()
        val folder = File(dir.removePrefix("file://"))
        for (name in listOf("mel.onnx", "context.onnx", "step.int8.onnx", "vocoder.onnx")) {
          if (!File(folder, name).exists()) throw EdgeException("Missing model file $name. Download the model again.")
        }
        try {
          val e = OrtEnvironment.getEnvironment()
          env = e
          fun options(main: Boolean) = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setIntraOpNumThreads(threads)
            if (main) {
              when (provider) {
                "nnapi" -> addNnapi()
                "xnnpack" -> addXnnpack(mapOf("intra_op_num_threads" to threads.toString()))
              }
            }
          }
          mel = e.createSession(File(folder, "mel.onnx").path, options(false))
          context = e.createSession(File(folder, "context.onnx").path, options(false))
          step = e.createSession(File(folder, "step.int8.onnx").path, options(true))
          vocoder = e.createSession(File(folder, "vocoder.onnx").path, options(false))
        } catch (t: Throwable) {
          releaseSessions()
          throw EdgeException("Could not load the model: ${t.message}", t)
        }
        (SystemClock.elapsedRealtime() - t0).toDouble()
      }
    }

    AsyncFunction("release") {
      synchronized(lock) { releaseSessions() }
    }

    /** wav (24 kHz mono) -> log-mel written into out (frames * 100). Returns frames. */
    AsyncFunction("computeMel") { wav: Float32Array, wavLength: Int, out: Float32Array, outLength: Int ->
      synchronized(lock) {
        val e = env ?: throw EdgeException("Model not loaded")
        val session = mel ?: throw EdgeException("Model not loaded")
        val input = readFloats(wav, wavLength)
        OnnxTensor.createTensor(e, FloatBuffer.wrap(input), longArrayOf(1, input.size.toLong())).use { t ->
          session.run(mapOf("wav" to t)).use { res ->
            val tensor = res[0] as OnnxTensor
            val frames = tensor.info.shape[1].toInt()
            val data = FloatArray(frames * N_MELS)
            tensor.floatBuffer.get(data)
            if (outLength < data.size) throw EdgeException("Mel buffer too small")
            writeFloats(out, data)
            frames
          }
        }
      }
    }

    /**
     * Full generation for one chunk. noise holds the starting noise
     * (duration * 100) and is overwritten with the final mel; outWav receives
     * (duration - refFrames) * 256 samples. Returns timings in ms.
     */
    AsyncFunction("synthesize") {
        ids: Int32Array, cond: Float32Array, schedule: Float32Array, noise: Float32Array, outWav: Float32Array, opts: SynthOptions ->
      val duration = opts.duration
      val refFrames = opts.refFrames
      val cfg = opts.cfg
      val progressBase = opts.progressBase
      val progressTotal = opts.progressTotal
      synchronized(lock) {
        val e = env ?: throw EdgeException("Model not loaded")
        val ctxSession = context ?: throw EdgeException("Model not loaded")
        val stepSession = step ?: throw EdgeException("Model not loaded")
        val vocSession = vocoder ?: throw EdgeException("Model not loaded")

        val frameCount = duration * N_MELS
        val tokenIds = readInts(ids, opts.tokens)
        val condData = readFloats(cond, frameCount)
        val ts = readFloats(schedule, opts.steps + 1)
        val steps = opts.steps
        val x = readFloats(noise, frameCount)
        val frameShape = longArrayOf(1, duration.toLong(), N_MELS.toLong())

        var t0 = SystemClock.elapsedRealtime()
        val ctxResult = OnnxTensor.createTensor(e, LongBuffer.wrap(tokenIds), longArrayOf(1, tokenIds.size.toLong())).use { text ->
          OnnxTensor.createTensor(e, FloatBuffer.wrap(condData), frameShape).use { c ->
            ctxSession.run(mapOf("text" to text, "cond" to c))
          }
        }
        val contextMs = SystemClock.elapsedRealtime() - t0

        t0 = SystemClock.elapsedRealtime()
        ctxResult.use { cr ->
          val ctx = cr[0] as OnnxTensor
          OnnxTensor.createTensor(e, FloatBuffer.wrap(floatArrayOf(cfg.toFloat())), longArrayOf(1)).use { cfgT ->
            val v = FloatArray(x.size)
            for (i in 0 until steps) {
              OnnxTensor.createTensor(e, FloatBuffer.wrap(x), frameShape).use { xt ->
                OnnxTensor.createTensor(e, FloatBuffer.wrap(floatArrayOf(ts[i])), longArrayOf(1)).use { tt ->
                  stepSession.run(mapOf("x" to xt, "ctx" to ctx, "t" to tt, "cfg" to cfgT)).use { r ->
                    (r[0] as OnnxTensor).floatBuffer.get(v)
                  }
                }
              }
              val dt = ts[i + 1] - ts[i]
              for (j in x.indices) x[j] += dt * v[j]
              sendEvent("onProgress", mapOf("done" to progressBase + i + 1, "total" to progressTotal))
            }
          }
        }
        val stepMs = SystemClock.elapsedRealtime() - t0

        // Generated frames only, as (1, mels, frames) for the vocoder.
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
        if ((duration - refFrames) * 256 < wav.size) throw EdgeException("Audio buffer too small")
        writeFloats(outWav, wav)
        writeFloats(noise, x)
        mapOf(
          "contextMs" to contextMs.toDouble(),
          "stepMs" to stepMs.toDouble(),
          "vocoderMs" to vocoderMs.toDouble(),
          "samples" to wav.size,
        )
      }
    }

    OnDestroy {
      synchronized(lock) { releaseSessions() }
    }
  }

  private fun releaseSessions() {
    listOf(mel, context, step, vocoder).forEach { runCatching { it?.close() } }
    mel = null
    context = null
    step = null
    vocoder = null
  }

  // Typed arrays are copied with read()/write(), which use the pointer taken
  // on the JS thread. toDirectBuffer() and .length call into the JS runtime,
  // which crashes the app when done from this background thread, so sizes
  // come from JS as plain numbers.
  private fun readFloats(array: Float32Array, count: Int): FloatArray {
    val bytes = ByteArray(count * 4)
    array.read(bytes, 0, bytes.size)
    val out = FloatArray(count)
    ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder()).asFloatBuffer().get(out)
    return out
  }

  private fun readInts(array: Int32Array, count: Int): LongArray {
    val bytes = ByteArray(count * 4)
    array.read(bytes, 0, bytes.size)
    val ints = IntArray(count)
    ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder()).asIntBuffer().get(ints)
    return LongArray(count) { ints[it].toLong() }
  }

  private fun writeFloats(array: Float32Array, data: FloatArray) {
    val bytes = ByteArray(data.size * 4)
    ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder()).asFloatBuffer().put(data)
    array.write(bytes, 0, bytes.size)
  }
}
