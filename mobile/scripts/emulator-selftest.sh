#!/usr/bin/env bash
# Runs the offline-engine self test (swaram://selftest) on a booted emulator
# and reports the outcome. Used by .github/workflows/mobile-apk.yml.
set -u
APK=${1:-swaram-latest.apk}
PROVIDER=${2:-xnnpack}
PKG=com.dattaharshithreddy.swaram

adb install -r "$APK" || { echo "::error title=Emulator::install failed"; exit 1; }

# The emulator's network can come up after boot; wait for DNS before testing.
for i in $(seq 1 30); do
  adb shell ping -c 1 -W 2 github.com >/dev/null 2>&1 && break
  sleep 4
done
adb logcat -c
adb logcat -v time > logcat.txt 2>&1 &
LOGCAT=$!

adb shell am start -W -a android.intent.action.VIEW -d "swaram://selftest?provider=$PROVIDER" "$PKG"

result=timeout
hidden=0
for i in $(seq 1 180); do
  sleep 10
  # Half way through, press Home: the rest (Studio download, scripts, mixing) must
  # keep running with the app in the background.
  if [ $hidden -eq 0 ] && grep -q "english words ok" logcat.txt; then
    adb shell input keyevent KEYCODE_HOME && hidden=1 && echo "app sent to the background"
  fi
  if grep -q "SWARAM_SELFTEST OK" logcat.txt; then result=ok; [ $hidden -eq 1 ] && echo "finished in the background"; break; fi
  if grep -q "SWARAM_SELFTEST FAIL" logcat.txt; then result=fail; break; fi
  if grep -qE "FATAL EXCEPTION|Fatal signal|Process $PKG \(pid [0-9]+\) has died|>>> $PKG <<<" logcat.txt; then
    sleep 8; result=crash; break
  fi
  if [ $((i % 6)) -eq 0 ]; then grep "SWARAM_SELFTEST" logcat.txt | tail -1 || true; fi
done
kill $LOGCAT 2>/dev/null || true

summary=$( {
  echo "result=$result provider=$PROVIDER background=$hidden"
  grep -E "SWARAM_SELFTEST|SwaramEdge" logcat.txt | tail -25
  grep -E "AndroidRuntime|FATAL|Fatal signal|DEBUG +:|libc +:|ReactNativeJS.*(Error|error)|onnxruntime" logcat.txt | head -45
} | cut -c1-220 )
echo "$summary"
encoded=$(echo "$summary" | sed 's/%/%25/g' | tr '\n' '\r' | sed 's/\r/%0A/g')
if [ "$result" = ok ]; then
  echo "::notice title=Emulator self test passed ($PROVIDER)::$encoded"
  exit 0
fi
echo "::error title=Emulator self test $result ($PROVIDER)::$encoded"
exit 1
