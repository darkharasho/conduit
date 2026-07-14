This directory exists because Bazzite (and immutable Fedora-based OSes) mount
`/usr/share/libratbag` read-only as part of the base image — custom `.device`
files cannot be dropped there at runtime. Conduit's one-prompt setup script
copies the stock libratbag data to `/etc/libratbag-custom` and writes a systemd
drop-in (`ratbagd.service.d/conduit-data-dir.conf`) that points ratbagd at that
writable directory via `LIBRATBAG_DATA_DIR`; the patched G502 X device file
(which extends `DeviceMatch=` to cover the LIGHTSPEED receiver USB ID) is then
placed alongside the stock files so ratbagd recognises the hardware. Files here
must use the `.device` extension that libratbag's INI parser expects.
