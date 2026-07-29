"use strict";

const RPM_POST_INSTALL = `if [ -f /opt/Factory/chrome-sandbox ]; then chown root:root /opt/Factory/chrome-sandbox; chmod 4755 /opt/Factory/chrome-sandbox; fi
install -d -m 0700 /var/cache/factory-update-manager/packages /var/lib/factory-update-manager/known-good
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
systemctl --global daemon-reload >/dev/null 2>&1 || true
systemctl --global enable factory-update-manager.service >/dev/null 2>&1 || true`;

const RPM_PRE_UNINSTALL = `if [ "$1" -eq 0 ]; then
  systemctl --global disable factory-update-manager.service >/dev/null 2>&1 || true
  systemctl --global daemon-reload >/dev/null 2>&1 || true
fi`;

module.exports = { RPM_POST_INSTALL, RPM_PRE_UNINSTALL };
