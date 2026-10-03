// The live source: LMU's shared-memory mapping.
//
// Lifted out of lmu_node.cc so the replay build can link a tape-backed
// implementation of the same seam against the identical conversion code.

#include "lmu_source.h"

#include <cstring>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace irdashies::lmu {
namespace {

const wchar_t* kSharedMemoryName = L"LMU_Data";

HANDLE gMap = NULL;
std::uint8_t* gView = nullptr;
const LMUObjectOut* gMapped = nullptr;

LMUSnapshotState liveState() {
  return {
      gMapped->generic.events.SME_UPDATE_SCORING,
      gMapped->generic.events.SME_UPDATE_TELEMETRY,
  };
}

}  // namespace

bool sourceOpen() {
  if (gMapped != nullptr) return true;
  sourceClose();

  gMap = OpenFileMappingW(FILE_MAP_READ, FALSE, kSharedMemoryName);
  if (gMap == NULL) return false;

  gView = static_cast<std::uint8_t*>(MapViewOfFile(gMap, FILE_MAP_READ, 0, 0, 0));
  if (gView == NULL) {
    CloseHandle(gMap);
    gMap = NULL;
    return false;
  }

  MEMORY_BASIC_INFORMATION region{};
  if (VirtualQuery(gView, &region, sizeof(region)) == 0 ||
      region.RegionSize < sizeof(LMUObjectOut)) {
    sourceClose();
    return false;
  }

  gMapped = reinterpret_cast<const LMUObjectOut*>(gView);
  return true;
}

void sourceClose() {
  gMapped = nullptr;
  if (gView != nullptr) {
    UnmapViewOfFile(gView);
    gView = nullptr;
  }
  if (gMap != NULL) {
    CloseHandle(gMap);
    gMap = NULL;
  }
}

bool sourceCapture(LMUObjectOut& out) {
  if (gMapped == nullptr) return false;

  for (int attempt = 0; attempt < 4; ++attempt) {
    // Cheap gate before the expensive part. The copy below is ~317 KB out of
    // a mapping the sim is actively writing, and an attempt that was going to
    // fail used to pay for it in full before anything was checked. Two
    // counter reads cost sixteen bytes and catch a writer mid-burst first.
    const LMUSnapshotState before = liveState();
    MemoryBarrier();
    if (!IsQuietLmuWriter(before, liveState())) continue;

    MemoryBarrier();
    LMUObjectOut candidate;
    std::memcpy(&candidate, gMapped, sizeof(candidate));
    MemoryBarrier();
    const LMUSnapshotState snapshot = {
        candidate.generic.events.SME_UPDATE_SCORING,
        candidate.generic.events.SME_UPDATE_TELEMETRY,
    };
    const LMUSnapshotState after = liveState();

    if (!IsCoherentLmuSnapshot(before, snapshot, after)) continue;

    out = candidate;
    return true;
  }

  return false;
}

bool sourceIsLive(const LMUObjectOut& snapshot) {
  const auto window = reinterpret_cast<HWND>(
      static_cast<uintptr_t>(snapshot.generic.appInfo.mAppWindow));
  return window != NULL && ::IsWindow(window);
}

}  // namespace irdashies::lmu
