#!/usr/bin/env python3
"""Continue the frozen 7f16 backlog operation without replacing its runtime."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = '7f16c5f267711373fb23af187cbd933a3c942634'
ALLOWED = {
    'infra/scripts/backlog-cancellation-host.mjs',
    'infra/scripts/backlog-cancellation-pending-client.cjs',
    'infra/scripts/resume-backlog-pending.py',
    'apps/api/src/webhook/webhook-backlog-cancellation-postgres.spec.ts',
    'docs/operations/runbooks/webhook-backlog-cancellation.md',
}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: resume-backlog-pending.py <same-private-request.json>')
    request_path = Path(sys.argv[1])
    fd = os.open(request_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 4096:
            raise SystemExit('Private request required')
        request_bytes = os.read(fd, 4097)
    finally:
        os.close(fd)
    request = json.loads(request_bytes)
    if request['sourceSha'] != RUNTIME or not re.fullmatch(r'[a-f0-9-]{36}', request['id']):
        raise SystemExit('Unsupported frozen runtime')
    if git('status', '--porcelain', '--untracked-files=no').strip():
        raise SystemExit('Clean committed controller required')
    controller = git('rev-parse', 'HEAD').decode().strip()
    subprocess.run(['git', 'merge-base', '--is-ancestor', RUNTIME, controller], cwd=ROOT, check=True)
    changed = set(git('diff', '--name-only', RUNTIME, controller).decode().splitlines())
    if not changed or not changed.issubset(ALLOWED):
        raise SystemExit('Controller changes exceed the pending continuation boundary')
    reason = os.environ.get('MAXIM_DEPLOY_EMERGENCY_REASON', '').strip()
    if os.environ.get('MAXIM_DEPLOY_EMERGENCY_BYPASS') == '1':
        if not reason:
            raise SystemExit('Emergency continuation requires a recorded reason')
    else:
        subprocess.run(['node', 'scripts/ci/assert-green.mjs', controller], cwd=ROOT, check=True)
    # FLAG: The controller transports committed public tooling only. Runtime images,
    # frozen request, exact stopped generations and the original journal stay bound.
    archive = io.BytesIO(git('archive', controller, 'infra/scripts'))
    bundle = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='r:') as source, tarfile.open(fileobj=bundle, mode='w:gz') as target:
        for member in source:
            target.addfile(member, source.extractfile(member) if member.isfile() else None)
        proof = json.dumps({'controllerSha': controller, 'runtimeSha': RUNTIME, 'emergencyReason': reason, 'operation': request['id']}).encode()
        for name, data in [('.request.json', request_bytes), ('.controller.json', proof)]:
            member = tarfile.TarInfo(name)
            member.mode, member.size = 0o600, len(data)
            target.addfile(member, io.BytesIO(data))
    payload = bundle.getvalue()
    if len(payload) > 32 * 1024 * 1024:
        raise SystemExit('Controller bundle exceeds the transport limit')
    digest = hashlib.sha256(payload).hexdigest()
    parent = '/var/lib/maxim-deploy/backlog-cancellation-' + request['id']
    remote = f'''set -euo pipefail
umask 077
[[ "$(git rev-parse HEAD)" == {RUNTIME} ]]
[[ -z "$(git status --porcelain --untracked-files=no)" ]]
source infra/scripts/lib/deploy-lock.sh
acquire_deploy_lock
[[ -d {shlex.quote(parent)} ]]
pending_bundle=$(mktemp -d {shlex.quote(parent)}/pending-controller.XXXXXXXX)
cat > "$pending_bundle/bundle.tar.gz"
[[ "$(sha256sum "$pending_bundle/bundle.tar.gz" | cut -d ' ' -f1)" == {digest} ]]
tar -xzf "$pending_bundle/bundle.tar.gz" -C "$pending_bundle"
cat "$pending_bundle/.controller.json"
MAXIM_EXPECTED_DEPLOY_SHA={RUNTIME} node "$pending_bundle/infra/scripts/backlog-cancellation-host.mjs" --resume-pending < "$pending_bundle/.request.json"
'''
    result = subprocess.run([str(ROOT / 'infra/scripts/vps-connect.sh'), 'exec', remote], cwd=ROOT, input=payload)
    raise SystemExit(result.returncode)

if __name__ == '__main__':
    main()
