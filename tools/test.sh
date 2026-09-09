#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 tests/test_recovery.py
python3 tools/check-repository.py
python3 components/xray/test_profiles.py
node components/xray/test_luci_profile.cjs
sh components/mobile-backup/test-classifier.sh
sh components/mobile-backup/test-controller.sh
sh -n tools/capture-router.sh
sh -n tools/restore-router.sh
python3 -m compileall -q tools tests
