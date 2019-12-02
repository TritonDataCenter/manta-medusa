#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
#

#
# Medusa -- Manta Interactive Session Engine
#

NAME		= medusa

.DEFAULT_GOAL	= all
INCMAKE		= deps/eng/tools/mk

NODE_PREBUILT			= _prebuilt
NODE_PREBUILT_IMAGE		= fd2cc906-8938-11e3-beab-4359c665ac99
NODE_PREBUILT_VERSION		= v0.10.48
NODE_PREBUILT_TAG		= zone

ENGBLD_USE_BUILDIMAGE		= true
ENGBLD_REQUIRE			:= $(shell git submodule update --init deps/eng)

APPDIR		= opt/smartdc/$(NAME)

JS_FILES	= \
		lib/reflector.js \
		lib/control.js \
		lib/common.js \
		lib/asset.js

AGENT_JS_FILES	= \
		lib/agent.js

JSON_FILES	= package.json

#
# RELEASE ARTIFACTS
#
BUILD		= build
DIST		= $(BUILD)/dist
RELEASE_TARBALL	= $(DIST)/$(NAME)-pkg-$(STAMP).tar.gz

BASE_IMAGE_UUID = fd2cc906-8938-11e3-beab-4359c665ac99
BUILDIMAGE_NAME = mantav1-medusa
BUILDIMAGE_DESC	= Manta medusa
BUILDIMAGE_PKGSRC = zookeeper-client-3.4.3
AGENTS		= amon config registrar

REPO_MODULES = src/node-dummy

#
# BUILD CONFIGURATION
#
CLEAN_FILES	+= \
	$(BUILD) \
	node_modules \
	0-modules-stamp

SMF_MANIFESTS	= smf/manifests/$(NAME).xml

SAPI_MANIFESTS	= medusa registrar
SAPI_FILES	= \
	$(SAPI_MANIFESTS:%=sapi_manifests/%/manifest.json) \
	$(SAPI_MANIFESTS:%=sapi_manifests/%/template)

#
# COMMON DEFINITIONS FROM ENG.GIT
#
include $(INCMAKE)/Makefile.defs
include $(INCMAKE)/Makefile.smf.defs
include $(INCMAKE)/Makefile.node$(NODE_PREBUILT).defs
include $(INCMAKE)/Makefile.agent_prebuilt.defs


#
# REPOSITORY-SPECIFIC TARGETS
#
.PHONY: all
all:	0-modules-stamp deps/manta-scripts/.git

INSTALL_NODE_PATH = $(BUILD)/root/$(APPDIR)/build/node/bin

INSTALL_DIRS = \
	$(INSTALL_NODE_PATH) \
	$(BUILD)/root/opt/smartdc/boot \
	$(BUILD)/root/$(APPDIR)/boot \
	$(BUILD)/root/$(APPDIR)/boot/scripts \
	$(BUILD)/root/$(APPDIR)/lib \
	$(BUILD)/root/$(APPDIR)/smf/manifests \
	$(SAPI_MANIFESTS:%=$(BUILD)/root/$(APPDIR)/sapi_manifests/%) \
	$(BUILD)/asset \
	$(BUILD)/asset/lib

INSTALL_TARGETS = \
	$(INSTALL_DIRS) \
	$(INSTALL_NODE_PATH)/node \
	$(BUILD)/root/$(APPDIR)/boot/setup.sh \
	$(BUILD)/root/opt/smartdc/boot/setup.sh \
	$(BUILD)/root/$(APPDIR)/boot/scripts/backup.sh \
	$(BUILD)/root/$(APPDIR)/boot/scripts/services.sh \
	$(BUILD)/root/$(APPDIR)/boot/scripts/util.sh \
	$(BUILD)/root/$(APPDIR)/build/node/bin/node \
	$(JS_FILES:%=$(BUILD)/root/$(APPDIR)/%) \
	$(BUILD)/root/$(APPDIR)/package.json \
	$(SMF_MANIFESTS:%=$(BUILD)/root/$(APPDIR)/%) \
	$(SAPI_FILES:%=$(BUILD)/root/$(APPDIR)/%) \
	$(BUILD)/root/$(APPDIR)/node_modules \
	$(BUILD)/root/$(APPDIR)/asset.sh

$(INSTALL_NODE_PATH)/node: $(INSTALL_NODE_PATH) $(NODE_EXEC)
	cp $(NODE_EXEC) $@

$(INSTALL_DIRS):
	mkdir -p $@

$(BUILD)/root/opt/smartdc/boot/setup.sh:
	rm -f $(BUILD)/root/opt/smartdc/boot/setup.sh
	ln -s /opt/smartdc/$(NAME)/boot/setup.sh \
	    $(BUILD)/root/opt/smartdc/boot/setup.sh
	chmod 755 $(BUILD)/root/opt/smartdc/$(NAME)/boot/setup.sh

$(BUILD)/root/$(APPDIR)/boot/%.sh: boot/%.sh
	cp $< $@

$(BUILD)/root/$(APPDIR)/boot/scripts/backup.sh:
	cp deps/manta-scripts/backup.sh $@

$(BUILD)/root/$(APPDIR)/boot/scripts/services.sh:
	cp deps/manta-scripts/services.sh $@

$(BUILD)/root/$(APPDIR)/boot/scripts/util.sh:
	cp deps/manta-scripts/util.sh $@

$(BUILD)/root/$(APPDIR)/lib/%.js: lib/%.js
	cp $< $@

$(BUILD)/root/$(APPDIR)/package.json: package.json
	cp $< $@

$(BUILD)/root/$(APPDIR)/smf/manifests/%: smf/manifests/%
	cp $< $@

$(BUILD)/root/$(APPDIR)/sapi_manifests/%: sapi_manifests/%
	cp $< $@

# sigh
0-modules-stamp: $(NPM_EXEC) package.json
	$(NPM) install
	touch 0-modules-stamp

$(BUILD)/root/$(APPDIR)/node_modules: 0-modules-stamp
	rm -rf $@
	cp -r node_modules $@

#
# MARLIN JOB AGENT ASSET TARGETS:
#
ASSET_TARGETS = \
	$(BUILD)/asset/node_modules \
	$(BUILD)/asset/node \
	$(AGENT_JS_FILES:%=$(BUILD)/asset/%)

$(BUILD)/asset/node_modules: 0-modules-stamp $(INSTALL_DIRS)
	rm -rf $@
	cp -r node_modules $@

$(BUILD)/asset/node: $(INSTALL_DIRS) $(NODE_EXEC)
	cp $(NODE_EXEC) $@

$(BUILD)/asset/lib/%.js: lib/%.js
	cp $< $@

$(BUILD)/root/$(APPDIR)/asset.sh: $(ASSET_TARGETS)
	./tools/make_asset $(BUILD)/asset $@


.PHONY: install
install: $(INSTALL_TARGETS)


#
# IMAGE BUILD/PUBLICATION TARGETS
#
.PHONY: release
release: $(RELEASE_TARBALL)

$(RELEASE_TARBALL): $(DIST) $(INSTALL_TARGETS)
	mkdir -p $(BUILD)/root/opt/smartdc
	(cd $(BUILD) && $(TAR) cf - root/opt) | pigz > $@

$(DIST):
	mkdir -p $@

.PHONY: publish
publish: $(RELEASE_TARBALL)
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(NAME)-pkg-$(STAMP).tar.gz

.PHONY: check
check:: 0-modules-stamp
	$(NODE) ./node_modules/.bin/jshint $(JS_FILES) $(AGENT_JS_FILES)
	$(NODE) ./node_modules/.bin/jscs $(JS_FILES) $(AGENT_JS_FILES)

#
# COMMON TARGETS FROM ENG.GIT
#
include $(INCMAKE)/Makefile.deps
include $(INCMAKE)/Makefile.targ
include $(INCMAKE)/Makefile.smf.targ
include $(INCMAKE)/Makefile.node$(NODE_PREBUILT).targ
include $(INCMAKE)/Makefile.agent_prebuilt.targ
