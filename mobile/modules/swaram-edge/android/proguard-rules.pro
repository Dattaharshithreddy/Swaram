# ONNX Runtime's native code finds its Java classes, fields and methods by
# name over JNI, so release shrinking (R8) must not rename or remove them.
-keep class ai.onnxruntime.** { *; }
-keepclassmembers class ai.onnxruntime.** { *; }
