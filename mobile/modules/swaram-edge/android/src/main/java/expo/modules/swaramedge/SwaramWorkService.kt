package expo.modules.swaramedge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the app alive (foreground service + partial wake lock) while a long
 * script is generated, and shows its progress as a notification. The work
 * itself runs in the app; this only stops Android from pausing or killing it
 * when the screen is off.
 */
class SwaramWorkService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra("title") ?: "Swaram"
    val text = intent?.getStringExtra("text") ?: "Generating…"
    val notification = build(this, title, text, 0, 0)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "swaram:generate").apply {
        setReferenceCounted(false)
        acquire(12 * 60 * 60 * 1000L)
      }
    }
    return START_NOT_STICKY
  }

  // Android 15+: data-sync services get a daily time limit; stop cleanly when it's reached.
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    runCatching { wakeLock?.release() }
    wakeLock = null
    super.onDestroy()
  }

  companion object {
    const val CHANNEL_ID = "swaram-work"
    const val NOTIFICATION_ID = 4207

    fun build(ctx: Context, title: String, text: String, done: Int, total: Int): Notification {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Generating audio", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Progress of long scripts made on this phone"
          },
        )
      }
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val pending = launch?.let {
        PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL_ID) else Notification.Builder(ctx)
      return builder
        .setSmallIcon(ctx.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .apply {
          if (total > 0) setProgress(total, done, false)
          if (pending != null) setContentIntent(pending)
        }
        .build()
    }
  }
}
