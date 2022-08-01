#!/bin/bash
set -e
DEV_ROOT=$1
JS_FILE=$2

export MACH_USE_SYSTEM_PYTHON=1
cd $DEV_ROOT
./mach lint -l eslint --fix $JS_FILE
