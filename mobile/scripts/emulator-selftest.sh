#!/usr/bin/env bash
# Runs the offline-engine self test (swaram://selftest) on a booted emulator
# and reports the outcome. Used by .github/workflows/mobile-apk.yml.
set -u
APK=${1:-swaram-latest.apk}
PROVIDER=${2:-xnnpack}
PKG=com.dattaharshithreddy.swaram

adb install -r "$APK" || { echo "::error title=Emulator::install failed"; exit 1; }
adb logcat -c
adb logcat -v time > logcat.txt 2>&1 &
LOGCAT=$!

adb shell am start -W -a android.intent.action.VIEW -d "swaram://selftest?provider=$PROVIDER" "$PKG"

result=timeout
for i in $(seq 1 180); do
  sleep 10
  if grep -q "SWARAM_SELFTEST OK" logcat.txt; then result=ok; break; fi
  if grep -q "SWARAM_SELFTEST FAIL" logcat.txt; then result=fail; break; fi
  if grep -qE "FATAL EXCEPTION|Fatal signal|Process $PKG \(pid [0-9]+\) has died|>>> $PKG <<<" logcat.txt; then
    sleep 8; result=crash; break
  fi
  if [ $((i % 6)) -eq 0 ]; then grep "SWARAM_SELFTEST" logcat.txt | tail -1 || true; fi
done
kill $LOGCAT 2>/dev/null || true

summary=$( {
  echo "result=$result provider=$PROVIDER"
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
