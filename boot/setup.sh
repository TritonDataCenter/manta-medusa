#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
SVC_ROOT=/opt/smartdc/medusa
CONFIG_FILE=$SVC_ROOT/etc/config.json
ZONE_UUID=$(zonename)
GROUP_NAME=medusa
USER_NAME=medusa

source ${DIR}/scripts/util.sh
source ${DIR}/scripts/services.sh


export PATH=$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH


function manta_setup_medusa {
    if ! getent group ${GROUP_NAME}; then
      /usr/sbin/groupadd ${GROUP_NAME}
    fi
    if ! getent passwd ${USER_NAME}; then
      /usr/sbin/useradd -g ${GROUP_NAME} -s /bin/bash \
        -d /home/${USER_NAME} ${USER_NAME}
    fi
    if [[ ! -d /home/${USER_NAME} ]]; then
      mkdir /home/${USER_NAME}
    fi
    chown ${USER_NAME}:${GROUP_NAME} /home/${USER_NAME}
    chmod 700 /home/${USER_NAME}


    /usr/bin/sed "s,@@PREFIX@@,${SVC_ROOT},g" \
      $SVC_ROOT/smf/manifests/medusa.xml \
      > $SVC_ROOT/smf/manifests/medusa.xml.tmp
    mv $SVC_ROOT/smf/manifests/medusa.xml.tmp \
      $SVC_ROOT/smf/manifests/medusa.xml
    svccfg import $SVC_ROOT/smf/manifests/medusa.xml
    svcadm enable medusa
}



# Mainline

echo "Running common setup scripts"
manta_common_presetup

echo "Adding local manifest directories"
manta_add_manifest_dir "/opt/smartdc/medusa"

manta_common_setup "medusa"

manta_ensure_zk

echo "Updating medusa"
manta_setup_medusa

manta_common_setup_end

exit 0
