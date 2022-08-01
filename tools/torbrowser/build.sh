#!/bin/bash
set -e
DEV_ROOT=$1

cd $DEV_ROOT
./mach build
./mach build stage-package
