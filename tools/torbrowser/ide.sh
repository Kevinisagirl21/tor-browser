#!/bin/bash
set -e
IDE=$1
DEV_ROOT=$2

export MACH_USE_SYSTEM_PYTHON=1
cd $DEV_ROOT
./mach ide $IDE
