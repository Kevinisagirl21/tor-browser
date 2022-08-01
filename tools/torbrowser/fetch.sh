#!/bin/sh
set -e

BINARIES_DIR=$1

# download the current downloads.json
wget https://aus1.torproject.org/torbrowser/update_3/alpha/downloads.json
# get url for latest alpha linux en_US package
TOR_BROWSER_VERSION=$(grep -Eo "\"version\":\"[0-9.a]+\"" downloads.json | grep -Eo "[0-9.a]+")
TOR_BROWSER_PACKAGE="tor-browser-linux64-${TOR_BROWSER_VERSION}_en-US.tar.xz"
TOR_BROWSER_PACKAGE_URL="https://dist.torproject.org/torbrowser/${TOR_BROWSER_VERSION}/${TOR_BROWSER_PACKAGE}"

# remove download manifest
rm downloads.json

# clear out previous tor-browser and previous package
rm -rf "${BINARIES_DIR}/dev"
rm -f "${TOR_BROWSER_PACKAGE}"

# download
rm -f "${TOR_BROWSER_PACKAGE}"
wget "${TOR_BROWSER_PACKAGE_URL}"
mkdir -p "${BINARIES_DIR}"

# and extract
tar -xf ${TOR_BROWSER_PACKAGE} -C "${BINARIES_DIR}"
mv "${BINARIES_DIR}/tor-browser_en-US" "${BINARIES_DIR}/dev"

# cleanup
rm -f "${TOR_BROWSER_PACKAGE}"
