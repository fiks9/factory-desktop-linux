"use strict";

const RPM_POST_INSTALL = `if [ -f /opt/Factory/chrome-sandbox ]; then chown root:root /opt/Factory/chrome-sandbox; chmod 4755 /opt/Factory/chrome-sandbox; fi
install -d -m 0700 /var/cache/factory-update-manager/packages /var/lib/factory-update-manager/known-good
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
USER_SERVICES="factory-update-manager.service factory-droid-daemon.service"
systemctl --global enable $USER_SERVICES >/dev/null 2>&1 || true
for runtime in /run/user/[0-9]*; do
  [ -d "$runtime" ] && [ -S "$runtime/bus" ] || continue
  uid=\${runtime##*/}
  user=$(getent passwd "$uid" | cut -d: -f1 || true)
  [ -n "$user" ] || continue
  runuser -u "$user" -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user daemon-reload >/dev/null 2>&1 || true
  runuser -u "$user" -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user enable --now $USER_SERVICES >/dev/null 2>&1 || true
done`;

const RPM_PRE_UNINSTALL = `if [ "$1" -eq 0 ]; then
  USER_SERVICES="factory-update-manager.service factory-droid-daemon.service"
  systemctl --global disable $USER_SERVICES >/dev/null 2>&1 || true
  for runtime in /run/user/[0-9]*; do
    [ -d "$runtime" ] && [ -S "$runtime/bus" ] || continue
    uid=\${runtime##*/}
    user=$(getent passwd "$uid" | cut -d: -f1 || true)
    [ -n "$user" ] || continue
    runuser -u "$user" -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user disable --now $USER_SERVICES >/dev/null 2>&1 || true
    runuser -u "$user" -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user daemon-reload >/dev/null 2>&1 || true
  done
fi`;

module.exports = { RPM_POST_INSTALL, RPM_PRE_UNINSTALL };
