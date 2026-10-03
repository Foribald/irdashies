// The replay source: a recorded tape standing in for LMU's shared memory.
//
// Links against the same lmu_node.cc as the production addon, so a tape goes
// through the real snapshot-to-JS conversion rather than a mock of it.
//
// Configured out of band, like the iRacing replay launcher:
//   IRDASHIES_LMU_REPLAY        tape path
//   IRDASHIES_LMU_REPLAY_SPEED  playback speed, 0.25 to 100
//   IRDASHIES_LMU_REPLAY_LOOP   "1" to restart at the end

#include "../lmu_source.h"
#include "lmu_tape.h"

#include <chrono>
#include <cstdlib>
#include <memory>
#include <string>

namespace irdashies::lmu {
namespace {

using irdashies::lmu_replay::RecordKind;
using irdashies::lmu_replay::TapeReader;
using irdashies::lmu_replay::TapeReadResult;
using irdashies::lmu_replay::TapeRecordHeader;

constexpr double kMinSpeed = 0.25;
constexpr double kMaxSpeed = 100.0;

std::unique_ptr<TapeReader> gReader;
LMUObjectOut gPending{};
bool gHasPending = false;
/** Set by a Disconnect record, so the player reports the sim going away. */
bool gDisconnected = false;
bool gExhausted = false;
double gSpeed = 1.0;
bool gLoop = false;
std::uint64_t gStartedAtMicros = 0;
std::uint64_t gPendingAtMicros = 0;

std::uint64_t nowMicros() {
  using namespace std::chrono;
  return static_cast<std::uint64_t>(
      duration_cast<microseconds>(steady_clock::now().time_since_epoch())
          .count());
}

std::string envOrEmpty(const char* name) {
#ifdef _WIN32
  char* value = nullptr;
  std::size_t size = 0;
  if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) return {};
  std::string result(value);
  std::free(value);
  return result;
#else
  const char* value = std::getenv(name);
  return value == nullptr ? std::string{} : std::string{value};
#endif
}

/** Reads the next snapshot record, skipping the bookkeeping ones. */
bool advance() {
  if (!gReader) return false;

  while (true) {
    TapeRecordHeader record{};
    std::string error;
    const auto result = gReader->readNext(record, gPending, error);

    if (result == TapeReadResult::Error) {
      gExhausted = true;
      return false;
    }
    if (result == TapeReadResult::EndOfFile) {
      if (!gLoop || !gReader->rewind(error)) {
        gExhausted = true;
        return false;
      }
      // A loop boundary is a disconnect: the app sees the session end and a
      // new one begin, which is what a restarted recording actually is.
      gStartedAtMicros = nowMicros();
      gDisconnected = true;
      return false;
    }

    const auto kind = static_cast<RecordKind>(record.kind);
    if (kind == RecordKind::Disconnect) {
      gDisconnected = true;
      return false;
    }
    if (kind == RecordKind::End) {
      if (!gLoop || !gReader->rewind(error)) {
        gExhausted = true;
        return false;
      }
      gStartedAtMicros = nowMicros();
      gDisconnected = true;
      return false;
    }
    if (kind == RecordKind::Keyframe || kind == RecordKind::Delta) {
      gPendingAtMicros = record.elapsedMicros;
      gHasPending = true;
      return true;
    }
    // Any other kind is bookkeeping; keep reading.
  }
}

}  // namespace

bool sourceOpen() {
  if (gReader) return true;

  const std::string path = envOrEmpty("IRDASHIES_LMU_REPLAY");
  if (path.empty()) return false;

  auto reader = std::make_unique<TapeReader>();
  std::string error;
  if (!reader->open(path, error)) return false;

  const std::string speed = envOrEmpty("IRDASHIES_LMU_REPLAY_SPEED");
  if (!speed.empty()) {
    const double parsed = std::atof(speed.c_str());
    if (parsed >= kMinSpeed && parsed <= kMaxSpeed) gSpeed = parsed;
  }
  gLoop = envOrEmpty("IRDASHIES_LMU_REPLAY_LOOP") == "1";

  gReader = std::move(reader);
  gStartedAtMicros = nowMicros();
  gHasPending = false;
  gDisconnected = false;
  gExhausted = false;
  return true;
}

void sourceClose() {
  gReader.reset();
  gHasPending = false;
  gDisconnected = false;
  gExhausted = false;
}

bool sourceCapture(LMUObjectOut& out) {
  if (!gReader || gExhausted) return false;

  if (gDisconnected) {
    // Reported once, then playback carries on with whatever follows.
    gDisconnected = false;
    return false;
  }

  if (!gHasPending && !advance()) return false;

  // Hold the frame until its recorded moment comes round, so a tape plays at
  // the cadence it was captured at rather than as fast as it can be read.
  const std::uint64_t elapsed = nowMicros() - gStartedAtMicros;
  const auto due = static_cast<std::uint64_t>(
      static_cast<double>(gPendingAtMicros) / gSpeed);
  if (elapsed < due) return false;

  out = gPending;
  gHasPending = false;
  return true;
}

bool sourceIsLive(const LMUObjectOut& snapshot) {
  // The window the tape recorded is long gone, so the live check cannot apply.
  // A tape is live while it still has frames to give.
  (void)snapshot;
  return gReader != nullptr && !gExhausted;
}

}  // namespace irdashies::lmu
