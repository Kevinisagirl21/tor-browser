.DEFAULT_GOAL := all

# https://stackoverflow.com/questions/18136918/how-to-get-current-relative-directory-of-your-makefile
mkfile_path := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

DEV_ROOT = $(mkfile_path)/../..
BINARIES = $(DEV_ROOT)/.binaries
BUILD_OUTPUT = $(DEV_ROOT)/obj-x86_64-pc-linux-gnu

config:
	./config.sh $(DEV_ROOT)

ide-vscode:
	./ide.sh vscode $(DEV_ROOT)

ide-eclipse:
	./ide.sh eclipse $(DEV_ROOT)

ide-visualstudio:
	./ide.sh visualstudio $(DEV_ROOT)

fetch:
	./fetch.sh $(BINARIES)

build:
	./build.sh $(DEV_ROOT)

deploy:
	./deploy.sh $(BINARIES) $(BUILD_OUTPUT)

all: build deploy

run:
	$(BINARIES)/dev/Browser/start-tor-browser -v

jslint:
	./jslint.sh $(DEV_ROOT) $(JS)

clobber:
	./clobber.sh $(DEV_ROOT)

clean:
	rm -rf $(BUILD_OUTPUT)

