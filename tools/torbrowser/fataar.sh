#!/bin/bash
set -e
DEV_ROOT=$1
ARCHS=$2

cd $DEV_ROOT

glue=""
if [[ "$ARCHS" == *"armv7"* ]]; then
	export MOZ_ANDROID_FAT_AAR_ARMEABI_V7A=$DEV_ROOT/obj-arm-linux-androideabi/gradle/build/mobile/android/geckoview/outputs/aar/geckoview-withGeckoBinaries-debug.aar
	glue="$glue,armeabi-v7a"
fi
if [[ "$ARCHS" == *"aarch64"* ]]; then
	export MOZ_ANDROID_FAT_AAR_ARM64_V8A=$DEV_ROOT/obj-aarch64-linux-android/gradle/build/mobile/android/geckoview/outputs/aar/geckoview-withGeckoBinaries-debug.aar
	glue="$glue,arm64-v8a"
fi
if [[ "$ARCHS" == *"x86"* ]]; then
	export MOZ_ANDROID_FAT_AAR_X86=$DEV_ROOT/obj-i386-linux-android/gradle/build/mobile/android/geckoview/outputs/aar/geckoview-withGeckoBinaries-debug.aar
	glue="$glue,x86"
fi
if [[ "$ARCHS" == *"x86_64"* ]]; then
	export MOZ_ANDROID_FAT_AAR_X86_64=$DEV_ROOT/obj-x86_64-linux-android/gradle/build/mobile/android/geckoview/outputs/aar/geckoview-withGeckoBinaries-debug.aar
	glue="$glue,x86_64"
fi
if [ -z "$glue" ]; then
	echo "The architectures have not specified or are not valid."
	echo "Usage: make fat-aar ARCHS=\"\$archs\""
	echo "Valid architectures are armv7 aarch64 x86 x86_64, and must be separated with a space."
	exit 1
fi
export MOZ_ANDROID_FAT_AAR_ARCHITECTURES=${glue:1}

MOZCONFIG=mozconfig-android-all ./mach configure
MOZCONFIG=mozconfig-android-all ./mach build
