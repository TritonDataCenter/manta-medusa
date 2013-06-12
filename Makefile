#
# Medusa -- Manta Interactive Session Engine
#

NAME		= medusa

.DEFAULT_GOAL	= all
INCMAKE		= deps/eng/tools/mk

NODE_PREBUILT			= _prebuilt
NODE_PREBUILT_CC_VERSION	= 4.6.2
NODE_PREBUILT_VERSION		= v0.8.24
NODE_PREBUILT_TAG		= zone

$(INCMAKE)/%:
	git submodule update --init deps/eng

APPDIR		= opt/smartdc/$(NAME)

JS_FILES	= \
		lib/reflector.js \
		lib/control.js \
		lib/common.js \
		lib/asset.js
JSON_FILES	= package.json

#
# RELEASE ARTIFACTS
#
BUILD		= build
DIST		= $(BUILD)/dist
RELEASE_TARBALL	= $(DIST)/$(NAME)-pkg-$(STAMP).tar.bz2

REPO_MODULES = src/node-dummy

#
# BUILD CONFIGURATION
#
CLEAN_FILES	+= \
	$(BUILD) \
	node_modules \
	0-modules-stamp

SMF_DTD		= deps/eng/tools/service_bundle.dtd.1
SMF_MANIFESTS	= smf/manifests/$(NAME).xml

SAPI_MANIFESTS	= medusa
SAPI_FILES	= \
	$(SAPI_MANIFESTS:%=sapi_manifests/%/manifest.json) \
	$(SAPI_MANIFESTS:%=sapi_manifests/%/template)

#
# COMMON DEFINITIONS FROM ENG.GIT
#
include $(INCMAKE)/Makefile.defs
include $(INCMAKE)/Makefile.smf.defs
include $(INCMAKE)/Makefile.node$(NODE_PREBUILT).defs


#
# REPOSITORY-SPECIFIC TARGETS
#
.PHONY: all
all:	0-modules-stamp

INSTALL_NODE_PATH = $(BUILD)/root/$(APPDIR)/build/node/bin

INSTALL_DIRS = \
	$(INSTALL_NODE_PATH) \
	$(BUILD)/root/$(APPDIR)/lib \
	$(BUILD)/root/$(APPDIR)/smf/manifests \
	$(SAPI_MANIFESTS:%=$(BUILD)/root/$(APPDIR)/sapi_manifests/%) \
	$(BUILD)/asset \
	$(BUILD)/asset/lib

INSTALL_TARGETS = \
	$(INSTALL_DIRS) \
	$(INSTALL_NODE_PATH)/node \
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
	$(BUILD)/asset/lib/agent.js

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
# MOUNTAIN-GORILLA TARGETS
#
.PHONY: release
release: $(RELEASE_TARBALL)

$(RELEASE_TARBALL): $(DIST) $(INSTALL_TARGETS)
	mkdir -p $(BUILD)/root/opt/smartdc
	(cd $(BUILD) && $(TAR) chf - root/opt) | bzip2 > $@

$(DIST):
	mkdir -p $@

.PHONY: publish
publish: $(RELEASE_TARBALL)
	@if [[ -z "$(BITS_DIR)" ]]; then \
		echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(NAME)-pkg-$(STAMP).tar.bz2

#
# COMMON TARGETS FROM ENG.GIT
#
include $(INCMAKE)/Makefile.deps
include $(INCMAKE)/Makefile.targ
include $(INCMAKE)/Makefile.smf.targ
include $(INCMAKE)/Makefile.node$(NODE_PREBUILT).targ
