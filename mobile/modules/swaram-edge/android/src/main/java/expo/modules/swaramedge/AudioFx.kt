package expo.modules.swaramedge

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** Background music mixing, noise cleanup and putting audio onto a video. */
object AudioFx {
  private const val RATE = AudioTools.RATE

  fun readWav16(f: File): FloatArray {
    RandomAccessFile(f, "r").use { raf ->
      val n = ((raf.length() - 44) / 2).toInt()
      val bytes = ByteArray(n * 2)
      raf.seek(44)
      raf.readFully(bytes)
      val sb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      return FloatArray(n) { sb.get(it) / 32768f }
    }
  }

  fun writeWav16(f: File, x: FloatArray) {
    val bb = ByteBuffer.allocate(44 + x.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    val data = x.size * 2
    bb.put("RIFF".toByteArray()); bb.putInt(36 + data); bb.put("WAVE".toByteArray())
    bb.put("fmt ".toByteArray()); bb.putInt(16); bb.putShort(1); bb.putShort(1)
    bb.putInt(RATE); bb.putInt(RATE * 2); bb.putShort(2); bb.putShort(16)
    bb.put("data".toByteArray()); bb.putInt(data)
    for (s in x) bb.putShort((s.coerceIn(-1f, 1f) * 32767f).toInt().toShort())
    f.writeBytes(bb.array())
  }

  private fun readF32(f: File): FloatArray {
    val bytes = f.readBytes()
    val out = FloatArray(bytes.size / 4)
    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out)
    return out
  }

  private fun writeF32(f: File, x: FloatArray) {
    val bb = ByteBuffer.allocate(x.size * 4).order(ByteOrder.LITTLE_ENDIAN)
    bb.asFloatBuffer().put(x)
    f.writeBytes(bb.array())
  }

  /**
   * Mixes music (any audio file, looped) under a voice WAV. The music dips
   * while the voice speaks (ducking) and fades in and out. Writes a WAV.
   */
  fun mixMusic(voiceWav: File, music: String, out: File, gain: Float, duck: Boolean, fadeSec: Float, tmpDir: File): Int {
    val voice = readWav16(voiceWav)
    val tmp = File(tmpDir, "swaram-music.f32")
    AudioTools.decodeToMono24k(music, tmp, 1200.0)
    val m = readF32(tmp)
    tmp.delete()
    if (m.isEmpty()) throw IllegalArgumentException("The music file has no audio")
    // Normalise the music to a steady level before applying the user's volume.
    var peak = 1e-6f
    for (v in m) peak = max(peak, abs(v))
    val norm = 0.7f / peak
    val tail = (1.0 * RATE).toInt()
    val n = voice.size + tail
    val outBuf = FloatArray(n)
    val fade = max(1, (fadeSec * RATE).toInt())
    // Voice envelope for ducking (fast attack, slow release).
    var env = 0f
    val attack = 1f - kotlin.math.exp(-1f / (0.01f * RATE))
    val release = 1f - kotlin.math.exp(-1f / (0.35f * RATE))
    for (i in 0 until n) {
      val v = if (i < voice.size) voice[i] else 0f
      val a = abs(v)
      env += (a - env) * (if (a > env) attack else release)
      val duckGain = if (duck) 1f - 0.65f * min(1f, env * 12f) else 1f
      val fadeGain = min(1f, min(i.toFloat() / fade, (n - 1 - i).toFloat() / fade))
      val music = m[i % m.size] * norm * gain * duckGain * fadeGain
      val s = v + music
      outBuf[i] = if (s > 0.95f) 0.95f + kotlin.math.tanh((s - 0.95f) * 4f) * 0.05f else if (s < -0.95f) -0.95f - kotlin.math.tanh((-s - 0.95f) * 4f) * 0.05f else s
    }
    writeWav16(out, outBuf)
    return n
  }

  // --- Noise cleanup: spectral gating with a noise profile from the quietest frames ---

  private fun fft(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
    val n = re.size
    var j = 0
    for (i in 1 until n) {
      var bit = n shr 1
      while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
      j = j xor bit
      if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
    }
    var len = 2
    while (len <= n) {
      val ang = 2 * PI / len * (if (inverse) 1 else -1)
      val wr = cos(ang); val wi = sin(ang)
      var i = 0
      while (i < n) {
        var cr = 1.0; var ci = 0.0
        for (k in 0 until len / 2) {
          val ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
          val ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
          re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai
          re[i + k] += ar; im[i + k] += ai
          val ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
        }
        i += len
      }
      len = len shl 1
    }
    if (inverse) for (i in 0 until n) { re[i] /= n; im[i] /= n }
  }

  /** Reduces steady background noise (fans, traffic hum, hiss) in a float32 file. */
  fun denoise(input: File, out: File, strength: Float): Int {
    val x = readF32(input)
    val nfft = 1024
    val hop = 256
    val win = DoubleArray(nfft) { 0.5 - 0.5 * cos(2 * PI * it / nfft) }
    val frames = max(1, (x.size - nfft) / hop + 1)
    val bins = nfft / 2 + 1
    val mags = Array(frames) { DoubleArray(bins) }
    val phases = Array(frames) { DoubleArray(bins) }
    val energy = DoubleArray(frames)
    val re = DoubleArray(nfft); val im = DoubleArray(nfft)
    for (f in 0 until frames) {
      for (i in 0 until nfft) { val idx = f * hop + i; re[i] = (if (idx < x.size) x[idx] else 0f) * win[i]; im[i] = 0.0 }
      fft(re, im, false)
      for (b in 0 until bins) {
        val mag = sqrt(re[b] * re[b] + im[b] * im[b])
        mags[f][b] = mag; phases[f][b] = kotlin.math.atan2(im[b], re[b]); energy[f] += mag
      }
    }
    // Noise profile: average spectrum of the quietest 15% of frames.
    val quiet = energy.indices.sortedBy { energy[it] }.take(max(1, frames * 15 / 100))
    val noise = DoubleArray(bins)
    for (f in quiet) for (b in 0 until bins) noise[b] += mags[f][b] / quiet.size
    val y = DoubleArray(x.size + nfft)
    val norm = DoubleArray(x.size + nfft)
    val prevGain = DoubleArray(bins) { 1.0 }
    val over = 1.5 + 2.0 * strength
    val floor = 0.12
    for (f in 0 until frames) {
      for (b in 0 until bins) {
        val g0 = max(floor, 1.0 - over * noise[b] / (mags[f][b] + 1e-9))
        val g = 0.6 * g0 + 0.4 * prevGain[b] // smooth over time to avoid "musical noise"
        prevGain[b] = g
        val m = mags[f][b] * g
        re[b] = m * cos(phases[f][b]); im[b] = m * sin(phases[f][b])
        if (b in 1 until nfft / 2) { re[nfft - b] = re[b]; im[nfft - b] = -im[b] }
      }
      fft(re, im, true)
      for (i in 0 until nfft) { val idx = f * hop + i; y[idx] += re[i] * win[i]; norm[idx] += win[i] * win[i] }
    }
    val outBuf = FloatArray(x.size) { if (norm[it] > 1e-6) (y[it] / norm[it]).toFloat() else 0f }
    writeF32(out, outBuf)
    return outBuf.size
  }

  /** Copies a video's picture track and puts the given AAC (.m4a) audio under it. Writes an MP4. */
  fun muxVideo(video: String, audioM4a: String, out: File): Long {
    val vEx = MediaExtractor().apply { setDataSource(video) }
    val aEx = MediaExtractor().apply { setDataSource(audioM4a) }
    var vTrack = -1
    for (i in 0 until vEx.trackCount) if (vEx.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true) { vTrack = i; break }
    if (vTrack < 0) { vEx.release(); aEx.release(); throw IllegalArgumentException("No video found in this file") }
    var aTrack = -1
    for (i in 0 until aEx.trackCount) if (aEx.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) { aTrack = i; break }
    if (aTrack < 0) { vEx.release(); aEx.release(); throw IllegalArgumentException("The audio file is empty") }
    val muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    try {
      vEx.selectTrack(vTrack)
      aEx.selectTrack(aTrack)
      val vFormat = vEx.getTrackFormat(vTrack)
      if (vFormat.containsKey(MediaFormat.KEY_ROTATION)) muxer.setOrientationHint(vFormat.getInteger(MediaFormat.KEY_ROTATION))
      val vOut = muxer.addTrack(vFormat)
      val aOut = muxer.addTrack(aEx.getTrackFormat(aTrack))
      muxer.start()
      val buf = ByteBuffer.allocate(4 * 1024 * 1024)
      val info = MediaCodec.BufferInfo()
      var videoEnd = 0L
      while (true) {
        val n = vEx.readSampleData(buf, 0)
        if (n < 0) break
        info.set(0, n, vEx.sampleTime, if (vEx.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        videoEnd = max(videoEnd, vEx.sampleTime)
        muxer.writeSampleData(vOut, buf, info)
        vEx.advance()
      }
      while (true) {
        val n = aEx.readSampleData(buf, 0)
        if (n < 0 || aEx.sampleTime > videoEnd + 500_000) break
        info.set(0, n, aEx.sampleTime, 0)
        muxer.writeSampleData(aOut, buf, info)
        aEx.advance()
      }
      muxer.stop()
      return videoEnd
    } finally {
      muxer.release()
      vEx.release()
      aEx.release()
    }
  }
}
