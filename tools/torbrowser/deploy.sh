#!/bin/bash
set -e
BINARIES=$1
BUILD_OUTPUT=$2

SCRIPT_DIR=$(realpath "$(dirname "$0")")

# Add built-in bridges
mkdir -p $BUILD_OUTPUT/_omni/defaults/preferences
cat $BUILD_OUTPUT/dist/bin/browser/defaults/preferences/000-tor-browser.js $SCRIPT_DIR/bridges.js >> $BUILD_OUTPUT/_omni/defaults/preferences/000-tor-browser.js
cd $BUILD_OUTPUT/_omni && zip -Xmr $BUILD_OUTPUT/dist/firefox/browser/omni.ja defaults/preferences/000-tor-browser.js
rm -rf $BUILD_OUTPUT/_omni

# Repackage the manual
# rm -rf $BUILD_OUTPUT/_omni
# mkdir $BUILD_OUTPUT/_omni
# unzip $BINARIES/dev/Browser/browser/omni.ja -d $BUILD_OUTPUT/_omni
# cd $BUILD_OUTPUT/_omni && zip -Xmr $BUILD_OUTPUT/dist/firefox/browser/omni.ja chrome/browser/content/browser/manual
# rm -rf $BUILD_OUTPUT/_omni

# copy binaries
cp -r $BUILD_OUTPUT/dist/firefox/* $BINARIES/dev/Browser
rm -rf $BINARIES/dev/Browser/TorBrowser/Data/Browser/profile.default/startupCache
