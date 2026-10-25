package expo.modules.swaramedge

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Audio file decoding (any format Android can play) and joining generated parts into one WAV. */
object AudioTools {
  const val RATE = 24000

  /**
   * Decodes an audio file to mono float32 at 24 kHz, written to [out]
   * (little-endian). Reads at most [maxSeconds]. Returns the sample count.
   */
  fun decodeToMono24k(src: String, out: File, maxSeconds: Double): Int {
    val ex = MediaExtractor()
    ex.setDataSource(src)
    var track = -1
    for (i in 0 until ex.trackCount) {
      if (ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
        track = i
        break
      }
    }
    if (track < 0) {
      ex.release()
      throw IllegalArgumentException("No audio found in this file")
    }
    ex.selectTrack(track)
    val format = ex.getTrackFormat(track)
    var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    var floatPcm = false
    val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
    codec.configure(format, null, null, 0)
    codec.start()

    var mono = FloatArray(rate * 10)
    var n = 0
    var limit = (maxSeconds * rate).toInt()
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    var outputDone = false
    try {
      while (!outputDone && n < limit) {
        if (!inputDone) {
          val inIdx = codec.dequeueInputBuffer(10_000)
          if (inIdx >= 0) {
            val buf = codec.getInputBuffer(inIdx)!!
            val size = ex.readSampleData(buf, 0)
            if (size < 0) {
              codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(inIdx, 0, size, ex.sampleTime, 0)
              ex.advance()
            }
          }
        }
        val outIdx = codec.dequeueOutputBuffer(info, 10_000)
        when {
          outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val of = codec.outputFormat
            rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            limit = (maxSeconds * rate).toInt()
            floatPcm = of.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
              of.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
          }
          outIdx >= 0 -> {
            val buf = codec.getOutputBuffer(outIdx)!!.order(ByteOrder.nativeOrder())
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            val frames = if (floatPcm) info.size / (4 * channels) else info.size / (2 * channels)
            if (n + frames > mono.size) mono = mono.copyOf(maxOf(mono.size * 2, n + frames))
            if (floatPcm) {
              val fb = buf.asFloatBuffer()
              for (f in 0 until frames) {
                var s = 0f
                for (c in 0 until channels) s += fb.get()
                mono[n++] = s / channels
              }
            } else {
              val sb = buf.asShortBuffer()
              for (f in 0 until frames) {
                var s = 0f
                for (c in 0 until channels) s += sb.get() / 32768f
                mono[n++] = s / channels
              }
            }
            codec.releaseOutputBuffer(outIdx, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
          }
        }
      }
    } finally {
      runCatching { codec.stop() }
      codec.release()
      ex.release()
    }
    val samples = resample(mono, minOf(n, limit), rate, RATE)
    val bytes = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
    bytes.asFloatBuffer().put(samples)
    out.writeBytes(bytes.array())
    return samples.size
  }

  private fun resample(x: FloatArray, n: Int, from: Int, to: Int): FloatArray {
    if (from == to) return x.copyOf(n)
    val outN = (n.toLong() * to / from).toInt()
    val out = FloatArray(outN)
    val ratio = from.toDouble() / to
    // Simple low-pass when downsampling: average over the source span.
    val span = maxOf(1, Math.round(ratio).toInt())
    for (i in 0 until outN) {
      val pos = i * ratio
      val j = pos.toInt()
      if (span > 1) {
        var s = 0f
        var c = 0
        for (k in j until minOf(j + span, n)) { s += x[k]; c++ }
        out[i] = if (c > 0) s / c else 0f
      } else {
        val frac = (pos - j).toFloat()
        val a = x[minOf(j, n - 1)]
        val b = x[minOf(j + 1, n - 1)]
        out[i] = a + (b - a) * frac
      }
    }
    return out
  }

  /**
   * Joins float32 part files into one 16-bit WAV at 24 kHz, cross-fading
   * [fade] samples between parts. Streams, so long scripts don't fill memory.
   * Returns the total sample count.
   */
  fun joinToWav(parts: List<File>, out: File, fade: Int): Long {
    var total = 0L
    BufferedOutputStream(FileOutputStream(out), 1 shl 16).use { os ->
      os.write(ByteArray(44)) // header written at the end
      var tail = FloatArray(0)
      val sb = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN)
      fun put(s: Float) {
        val v = (s.coerceIn(-1f, 1f) * 32767f).toInt().toShort()
        sb.clear(); sb.putShort(v); os.write(sb.array(), 0, 2)
        total++
      }
      for ((idx, part) in parts.withIndex()) {
        val bytes = part.readBytes()
        val x = FloatArray(bytes.size / 4)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(x)
        val k = if (idx == 0) 0 else minOf(fade, tail.size, x.size)
        // Tail of the previous part, faded into the start of this one.
        for (i in 0 until tail.size - k) put(tail[i])
        for (i in 0 until k) {
          val a = i.toFloat() / maxOf(1, k - 1)
          put(tail[tail.size - k + i] * (1 - a) + x[i] * a)
        }
        val keep = minOf(fade, x.size - k)
        for (i in k until x.size - keep) put(x[i])
        tail = x.copyOfRange(x.size - keep, x.size)
      }
      for (s in tail) put(s)
    }
    RandomAccessFile(out, "rw").use { raf ->
      val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      val dataBytes = total * 2
      h.put("RIFF".toByteArray()); h.putInt((36 + dataBytes).toInt()); h.put("WAVE".toByteArray())
      h.put("fmt ".toByteArray()); h.putInt(16); h.putShort(1); h.putShort(1)
      h.putInt(RATE); h.putInt(RATE * 2); h.putShort(2); h.putShort(16)
      h.put("data".toByteArray()); h.putInt(dataBytes.toInt())
      raf.seek(0)
      raf.write(h.array())
    }
    return total
  }

  /**
   * Encodes a 16-bit mono WAV (as written by joinToWav) to AAC in an .m4a
   * container: about a sixth of the size, plays everywhere (WhatsApp too).
   */
  fun encodeM4a(wav: File, out: File, bitrate: Int): Long {
    val raf = RandomAccessFile(wav, "r")
    val header = ByteArray(44)
    raf.readFully(header)
    val hb = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
    val rate = hb.getInt(24)
    val channels = hb.getShort(22).toInt()
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, channels).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
    }
    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    codec.start()
    val muxer = android.media.MediaMuxer(out.path, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var track = -1
    var muxing = false
    val info = MediaCodec.BufferInfo()
    val total = raf.length() - 44
    var read = 0L
    var inputDone = false
    var outputDone = false
    val chunk = ByteArray(8192)
    try {
      while (!outputDone) {
        if (!inputDone) {
          val inIdx = codec.dequeueInputBuffer(10_000)
          if (inIdx >= 0) {
            val buf = codec.getInputBuffer(inIdx)!!
            buf.clear()
            val n = raf.read(chunk, 0, minOf(chunk.size, buf.remaining()))
            if (n <= 0) {
              codec.queueInputBuffer(inIdx, 0, 0, read * 1_000_000L / (2L * channels * rate), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              buf.put(chunk, 0, n)
              codec.queueInputBuffer(inIdx, 0, n, read * 1_000_000L / (2L * channels * rate), 0)
              read += n
            }
          }
        }
        val outIdx = codec.dequeueOutputBuffer(info, 10_000)
        when {
          outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            track = muxer.addTrack(codec.outputFormat)
            muxer.start()
            muxing = true
          }
          outIdx >= 0 -> {
            val buf = codec.getOutputBuffer(outIdx)!!
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
            if (info.size > 0 && muxing) {
              buf.position(info.offset)
              buf.limit(info.offset + info.size)
              muxer.writeSampleData(track, buf, info)
            }
            codec.releaseOutputBuffer(outIdx, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
          }
        }
      }
    } finally {
      runCatching { codec.stop() }
      codec.release()
      if (muxing) runCatching { muxer.stop() }
      muxer.release()
      raf.close()
    }
    return total / (2L * channels)
  }
}
