"""Pinned inputs and the closed role/artifact inventory of the guided compile packet. Data only: no project
imports, no process, no network. The Bun compiler record is ONE object (the `bun` member of the pin file); the
three origin heads are one constant each. Everything else in the build, the workflow and the gate test must agree
with these values, and test_guided_build.py / test/gates/guided-packet-compile-gates.test.ts fail when it does not."""
import json
from pathlib import Path

PIN_PATH=Path(__file__).with_name('guided-compile-inputs.pin.json')
PIN=json.loads(PIN_PATH.read_bytes())
BUN=PIN['bun']
# Same shape as the reader builder's BASE record, derived from the single Bun object above.
BASE={'version':BUN['version'],'target':BUN['target'],'archiveSha256':BUN['archiveSha256'],'executableSha256':BUN['executableSha256']}
HEADS={'runtime':PIN['origins']['runtimeSdk']['head'],'sdk':PIN['origins']['agentSdk']['head'],'winter':PIN['origins']['winterCore']['head']}
TREES={'runtime':PIN['origins']['runtimeSdk']['tree'],'sdk':PIN['origins']['agentSdk']['tree'],'winter':PIN['origins']['winterCore']['tree']}
DEPENDENCIES=PIN['dependencies']
DEPENDENCY_PACKAGES=DEPENDENCIES['packages']
ALIASES=DEPENDENCIES['aliases']
TRIGGER_BRANCH=PIN['trigger']['branch']
RETENTION_DAYS=PIN['retentionDays']
MAX_PACKET_BYTES=PIN['limits']['packetBytes']
MAX_PACKET_ENTRIES=PIN['limits']['packetEntries']

# Origins staged under source/<name>. 'builder' carries this directory, the two reviewed compile-only entry adapters
# and the reader builder helpers it loads.
ORIGINS=('runtime','sdk','winter','builder')
ALIAS_ORIGINS=ORIGINS

# Four compiled roles. `entry` is a packet-relative path. `required` are inputs that MUST appear in that role's bundle.
ROLES={
  'runtimeEntry':{'entry':'source/sdk/packages/runtime/src/guest/linux-guided-host-query-main.ts','required':('source/sdk/packages/runtime/src/guest/linux-session-entry.ts','source/sdk/packages/runtime/src/guest/linux-session-admission.ts')},
  'providerWorker':{'entry':'source/builder/scripts/guest-guided-build/entries/provider-worker.ts','required':('source/runtime/scripts/guest-guided-provider/stub.ts','source/builder/scripts/guest-guided-build/entries/provider-worker-core.ts')},
  'hostClient':{'entry':'source/builder/scripts/guest-guided-build/entries/host-client.ts','required':(
    'source/builder/scripts/guest-guided-build/entries/host-client-core.ts','source/sdk/packages/sdk/src/guided-query-reader.ts','source/sdk/packages/runtime/src/guest/linux-guided-host-query-profile.ts',
    'source/winter/packages/core/src/cowork/guided-reader-adapter.ts','source/winter/packages/core/src/cowork/current-context.ts','source/winter/packages/core/src/cowork/current-context-resolver.ts','source/winter/packages/core/src/cowork/structured-instruction-mapper.ts')},
  'instructionReader':{'entry':'source/runtime/src/guest/instruction-reader-entry.ts','required':('source/runtime/src/guest/instruction-reader-transport.ts',)},
}
ROLE_NAMES=tuple(ROLES)
# Six native artifacts. Source is relative to the SDK origin's guest directory. `flags` is the closed per-artifact set.
GUEST_DIR='packages/runtime/src/guest'
STATIC_FLAGS=('-std=c11','-O2','-Wall','-Wextra','-Werror','-static')
SHARED_FLAGS=('-std=c11','-O2','-Wall','-Wextra','-Werror','-shared','-fPIC')
NATIVE={
  'toolLauncher':{'source':'linux-tool-compartment.c','flags':STATIC_FLAGS},
  'runtimeLauncher':{'source':'linux-runtime-compartment.c','flags':STATIC_FLAGS},
  'fileWorker':{'source':'file-worker.c','flags':STATIC_FLAGS},
  'processWorker':{'source':'process-worker.c','flags':STATIC_FLAGS},
  'ownerLibrary':{'source':'linux-session-owner.c','flags':SHARED_FLAGS},
  # The reader launcher keeps the reader packet's hardened dynamic recipe (build.NATIVE_FLAGS of the reader builder).
  'instructionReaderLauncher':{'source':'linux-instruction-reader-compartment.c','flags':None},
}
NATIVE_NAMES=tuple(NATIVE)
ARTIFACT_NAMES=ROLE_NAMES+NATIVE_NAMES
# Builder-origin files: this directory plus the reader builder's two modules this builder loads by hash-checked path.
READER_HELPERS=('scripts/guest-reader-build/build.py','scripts/guest-reader-build/provenance.py')
BUILDER_FILES=tuple('scripts/guest-guided-build/'+name for name in (
  'pins.py','graph.py','acquire.py','build.py','test_guided_build.py','README.md','guided-compile-inputs.pin.json','dependencies.lst','pin-deps.ts','entries/provider-worker.ts','entries/provider-worker-core.ts','entries/host-client.ts','entries/host-client-core.ts','guided-entries.test.ts'))+READER_HELPERS
def package_directory(identifier):
    # pnpm virtual-store directory name: scope slash becomes a plus.
    return identifier.replace('/','+')
def dependency_list():
    """The exact text of dependencies.lst: `<sha512> <tarball file> <url>` per pinned registry package, in pin order."""
    return ''.join(f"{item['sha512']} {package_directory(item['id'])}.tgz {item['url']}\n" for item in DEPENDENCY_PACKAGES)

# Winter Core inputs staged for the hostClient role: the closed set, never the whole repository.
WINTER_PREFIXES=('packages/protocol/src/','packages/protocol/package.json','packages/protocol/tsconfig.json','packages/core/src/cowork/','packages/core/src/runtime-state/records.ts','packages/core/src/runtime-sdk/model-tag.ts','packages/core/package.json','packages/core/tsconfig.json')
WINTER_ROOT_FILES=('package.json','tsconfig.base.json')
SDK_FAMILY_VERSION='0.0.53'
WORKSPACE_PACKAGE={'@yanlinglabs/winter-protocol':'packages/protocol'}
ALLOWED_BUN_EXTERNALS=('bun','bun:ffi')

def winter_eligible(name):
    if name in WINTER_ROOT_FILES:return True
    if name.endswith(('.test.ts','.test.tsx')) or '/test/' in name or '/__tests__/' in name:return False
    return any(name==prefix or (prefix.endswith('/') and name.startswith(prefix)) for prefix in WINTER_PREFIXES)
