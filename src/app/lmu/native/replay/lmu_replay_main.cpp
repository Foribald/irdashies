// Records and inspects LMU shared-memory tapes.
//
// The LMU analogue of irsdk_replay. It is deliberately smaller: LMU publishes
// one fixed struct rather than iRacing's variable-header triple buffer, so a
// tape is a sequence of whole snapshots and there is no schema to carry.
//
// Playback is not here. The iRacing tool can republish into an isolated
// shared-memory mapping because the reader is the SDK; for LMU the reader is
// our own addon, so the tape is played in-process by lmu_tape_node instead.

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include "lmu_rest_http.h"
#include "lmu_tape.h"

namespace {

using irdashies::lmu_replay::HttpResult;
using irdashies::lmu_replay::RecordKind;
using irdashies::lmu_replay::TapeReader;
using irdashies::lmu_replay::TapeReadResult;
using irdashies::lmu_replay::TapeRecordHeader;
using irdashies::lmu_replay::TapeWriter;

/** The same object the production addon maps; see lmu_node.cc. */
const wchar_t* kMappingName = L"LMU_Data";

std::atomic<bool> gStopRequested{false};

BOOL WINAPI consoleHandler(DWORD signal) {
  if (signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT ||
      signal == CTRL_CLOSE_EVENT) {
    gStopRequested = true;
    return TRUE;
  }
  return FALSE;
}

std::uint64_t nowMicros() {
  using namespace std::chrono;
  return static_cast<std::uint64_t>(
      duration_cast<microseconds>(steady_clock::now().time_since_epoch())
          .count());
}

struct Options {
  std::string command;
  std::string path;
  double durationSeconds = 0.0;
  std::uint32_t pollMillis = 10;
  std::uint32_t frames = 240;
  /** REST poll cadence while recording; 0 disables REST capture entirely. */
  std::uint32_t restIntervalMillis = 200;
  std::string restHost = "127.0.0.1";
  std::uint16_t restPort = 6397;
};

bool parseOptions(int argc, char** argv, Options& options, std::string& error) {
  if (argc < 2) {
    error = "Usage: lmu_replay <record|inspect|fixture> [options]";
    return false;
  }
  options.command = argv[1];

  for (int i = 2; i < argc; ++i) {
    const std::string arg = argv[i];
    const bool hasNext = i + 1 < argc;
    if ((arg == "--output" || arg == "--input") && hasNext) {
      options.path = argv[++i];
    } else if (arg == "--duration" && hasNext) {
      options.durationSeconds = std::atof(argv[++i]);
    } else if (arg == "--poll" && hasNext) {
      options.pollMillis = static_cast<std::uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--frames" && hasNext) {
      options.frames = static_cast<std::uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--rest-interval" && hasNext) {
      options.restIntervalMillis =
          static_cast<std::uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--rest-host" && hasNext) {
      options.restHost = argv[++i];
    } else if (arg == "--rest-port" && hasNext) {
      options.restPort = static_cast<std::uint16_t>(std::atoi(argv[++i]));
    } else if (arg == "--no-rest") {
      options.restIntervalMillis = 0;
    } else {
      error = "Unrecognised argument: " + arg;
      return false;
    }
  }

  if (options.path.empty()) {
    error = "An --output (record, fixture) or --input (inspect) path is required";
    return false;
  }
  if (options.pollMillis == 0) options.pollMillis = 1;
  return true;
}

/**
 * Paths polled while recording.
 *
 * Must stay in step with LMU_REST_TASKS in src/app/lmu/rest/tasks.ts, which is
 * the source of truth for what the app reads. A path recorded but unread is
 * harmless; a path read but never recorded replays as pending forever, which
 * is why this list errs towards recording everything.
 */
const char* kRestPaths[] = {
    "/rest/strategy/pitstop-estimate",
    "/rest/garage/UIScreen/RepairAndRefuel",
    "/rest/sessions",
    "/rest/sessions/weather",
};

struct PendingRest {
  std::string path;
  std::string body;
  std::uint64_t elapsedMicros;
};

/**
 * REST responses captured but not yet written.
 *
 * Polled on its own thread for one reason: the capture loop runs every 10 ms
 * and a loopback connect that fails can take a second, which would cost ~100
 * frames of the recording. Only the main thread ever touches the TapeWriter,
 * so the queue is the whole of the shared state and the writer needs no lock.
 */
std::mutex gRestMutex;
std::vector<PendingRest> gRestQueue;

/**
 * Fetches each path until stopped, queueing a record only when a body changes.
 *
 * Unchanged bodies are dropped here rather than written and deduplicated
 * later: at a 200 ms poll over a four-path set, most responses are identical
 * to the one before, and storing them all would bloat a tape for nothing.
 */
void restCaptureLoop(
    const std::string& host,
    std::uint16_t port,
    int intervalMs,
    int timeoutMs,
    std::uint64_t startedAt) {
  std::string startupError;
  if (!irdashies::lmu_replay::httpStartup(startupError)) {
    std::cerr << "REST capture disabled: " << startupError << "\n";
    return;
  }

  std::map<std::string, std::string> lastBody;
  bool announced = false;
  bool absent = false;

  while (!gStopRequested && !absent) {
    for (const char* path : kRestPaths) {
      if (gStopRequested) break;
      std::string body;
      const HttpResult result =
          irdashies::lmu_replay::httpGet(host, port, path, timeoutMs, body);

      if (result == HttpResult::Refused) {
        // Nothing is serving the API. An older LMU has none, so stop asking
        // rather than retry four paths a second for the whole session.
        std::cout << "No REST API on " << host << ":" << port
                  << "; recording shared memory only.\n";
        absent = true;
        break;
      }
      if (result != HttpResult::Ok) continue;

      auto& previous = lastBody[path];
      if (previous == body) continue;
      previous = body;

      if (!announced) {
        announced = true;
        std::cout << "REST API found; recording its responses too.\n";
      }
      std::lock_guard<std::mutex> guard(gRestMutex);
      gRestQueue.push_back({path, body, nowMicros() - startedAt});
    }
    if (absent || gStopRequested) break;
    Sleep(static_cast<DWORD>(intervalMs));
  }

  irdashies::lmu_replay::httpShutdown();
}

/**
 * Copies the mapping, retrying while the writer is mid-update.
 *
 * The same lock-free scheme the production addon uses: the update counters are
 * read either side of the copy, and a copy they disagree across was torn.
 */
bool captureSnapshot(const LMUObjectOut* mapped, LMUObjectOut& out) {
  for (int attempt = 0; attempt < 4; ++attempt) {
    const std::uint32_t beforeScoring =
        mapped->generic.events.SME_UPDATE_SCORING;
    const std::uint32_t beforeTelemetry =
        mapped->generic.events.SME_UPDATE_TELEMETRY;
    MemoryBarrier();
    std::memcpy(&out, mapped, sizeof(LMUObjectOut));
    MemoryBarrier();
    if (beforeScoring == mapped->generic.events.SME_UPDATE_SCORING &&
        beforeTelemetry == mapped->generic.events.SME_UPDATE_TELEMETRY &&
        beforeScoring == out.generic.events.SME_UPDATE_SCORING &&
        beforeTelemetry == out.generic.events.SME_UPDATE_TELEMETRY) {
      return true;
    }
  }
  return false;
}

int runRecord(const Options& options) {
  SetConsoleCtrlHandler(consoleHandler, TRUE);

  TapeWriter writer;
  std::string error;
  if (!writer.open(options.path, error)) {
    std::cerr << error << "\n";
    return 1;
  }

  std::cout << "Waiting for LMU shared memory...\n";

  HANDLE mapping = NULL;
  const std::uint8_t* view = nullptr;
  const std::uint64_t startedAt = nowMicros();
  bool wasMapped = false;
  LMUObjectOut snapshot{};
  std::uint64_t frames = 0;

  // On its own thread: see restCaptureLoop. Disabled with --no-rest, which is
  // the way to record a tape deliberately without them.
  std::thread restThread;
  if (options.restIntervalMillis > 0) {
    restThread = std::thread(
        restCaptureLoop,
        options.restHost,
        options.restPort,
        static_cast<int>(options.restIntervalMillis),
        // A loopback reply that takes this long means trouble, and the thread
        // must not sit on a dead socket while a session is being recorded.
        500,
        startedAt);
  }

  std::uint64_t restRecords = 0;

  while (!gStopRequested) {
    if (options.durationSeconds > 0.0) {
      const double elapsed =
          static_cast<double>(nowMicros() - startedAt) / 1'000'000.0;
      if (elapsed >= options.durationSeconds) break;
    }

    if (mapping == NULL) {
      mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, kMappingName);
      if (mapping != NULL) {
        view = static_cast<const std::uint8_t*>(
            MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(LMUObjectOut)));
        if (view == nullptr) {
          CloseHandle(mapping);
          mapping = NULL;
        } else {
          std::cout << "Mapped. Recording; Ctrl+C to stop.\n";
          wasMapped = true;
        }
      }
    }

    if (view != nullptr) {
      const auto* mapped = reinterpret_cast<const LMUObjectOut*>(view);
      if (captureSnapshot(mapped, snapshot)) {
        if (!writer.appendSnapshot(
                snapshot, nowMicros() - startedAt, error)) {
          std::cerr << error << "\n";
          break;
        }
        if (++frames % 500 == 0) {
          std::cout << "  " << frames << " frames\r" << std::flush;
        }
      }
    } else if (wasMapped) {
      if (!writer.appendDisconnect(nowMicros() - startedAt, error)) {
        std::cerr << error << "\n";
        break;
      }
      wasMapped = false;
      std::cout << "LMU went away; waiting again.\n";
    }

    // Drained here so only this thread writes to the tape. A REST record
    // between snapshots is exactly where the player expects to find one.
    {
      std::vector<PendingRest> pending;
      {
        std::lock_guard<std::mutex> guard(gRestMutex);
        pending.swap(gRestQueue);
      }
      for (const auto& entry : pending) {
        if (!writer.appendRest(
                entry.path, entry.body, entry.elapsedMicros, error)) {
          std::cerr << error << "\n";
          gStopRequested = true;
          break;
        }
        ++restRecords;
      }
    }

    Sleep(options.pollMillis);
  }

  // The loop also exits on --duration and on a write failure, neither of which
  // sets this. Without it the capture thread keeps polling and the join below
  // never returns, so the tape is never finished and the file stays empty.
  gStopRequested = true;
  if (restThread.joinable()) restThread.join();

  // Whatever the thread queued after the last drain.
  {
    std::vector<PendingRest> pending;
    {
      std::lock_guard<std::mutex> guard(gRestMutex);
      pending.swap(gRestQueue);
    }
    for (const auto& entry : pending) {
      if (writer.appendRest(
              entry.path, entry.body, entry.elapsedMicros, error)) {
        ++restRecords;
      }
    }
  }

  if (view != nullptr) UnmapViewOfFile(view);
  if (mapping != NULL) CloseHandle(mapping);

  if (!writer.finish(error)) {
    std::cerr << error << "\n";
    return 1;
  }
  std::cout << "\nWrote " << writer.recordCount() << " records to "
            << options.path << "\n";
  if (options.restIntervalMillis > 0) {
    std::cout << "  including " << restRecords << " REST records\n";
  }
  return 0;
}

int runInspect(const Options& options) {
  TapeReader reader;
  std::string error;
  if (!reader.open(options.path, error)) {
    std::cerr << error << "\n";
    return 1;
  }

  const auto& header = reader.fileHeader();
  std::cout << "Tape:            " << options.path << "\n"
            << "Format version:  " << header.formatVersion << "\n"
            << "Snapshot size:   " << header.snapshotSize << " bytes\n"
            << "Keyframe every:  " << header.keyframeInterval << " frames\n"
            << "Records:         " << header.recordCount << "\n"
            << "Duration:        "
            << static_cast<double>(header.durationMicros) / 1'000'000.0
            << " s\n";

  std::uint64_t keyframes = 0;
  std::uint64_t deltas = 0;
  std::uint64_t disconnects = 0;
  std::uint64_t restRecords = 0;
  std::uint64_t restBytes = 0;
  std::set<std::string> restPaths;
  std::uint64_t payloadBytes = 0;
  TapeRecordHeader record{};
  LMUObjectOut snapshot{};
  std::string restPath;
  std::string restBody;
  while (true) {
    const auto result =
        reader.readNext(record, snapshot, restPath, restBody, error);
    if (result == TapeReadResult::EndOfFile) break;
    if (result == TapeReadResult::Error) {
      std::cerr << error << "\n";
      return 1;
    }
    payloadBytes += record.payloadSize;
    switch (static_cast<RecordKind>(record.kind)) {
      case RecordKind::Keyframe: ++keyframes; break;
      case RecordKind::Delta: ++deltas; break;
      case RecordKind::Disconnect: ++disconnects; break;
      case RecordKind::Rest:
        ++restRecords;
        restBytes += record.payloadSize;
        restPaths.insert(restPath);
        break;
      default: break;
    }
  }

  const std::uint64_t snapshots = keyframes + deltas;
  std::cout << "Keyframes:       " << keyframes << "\n"
            << "Deltas:          " << deltas << "\n"
            << "Disconnects:     " << disconnects << "\n"
            << "REST records:    " << restRecords << " (" << restBytes
            << " bytes, " << restPaths.size() << " paths)\n"
            << "Payload bytes:   " << payloadBytes << "\n";
  for (const auto& path : restPaths) {
    std::cout << "  REST path:     " << path << "\n";
  }
  if (snapshots > 0) {
    const double raw =
        static_cast<double>(snapshots) * static_cast<double>(sizeof(LMUObjectOut));
    std::cout << "Compression:     "
              << (raw / static_cast<double>(payloadBytes ? payloadBytes : 1))
              << "x against raw snapshots\n";
  }
  return 0;
}

/**
 * Writes a synthetic tape.
 *
 * The format and the player can then be exercised without a copy of LMU, the
 * same role irsdk:fixture plays for the iRacing tool.
 */
int runFixture(const Options& options) {
  TapeWriter writer;
  std::string error;
  if (!writer.open(options.path, error)) {
    std::cerr << error << "\n";
    return 1;
  }

  LMUObjectOut snapshot{};
  snapshot.generic.gameVersion = 1902;
  snapshot.scoring.scoringInfo.mNumVehicles = 2;
  snapshot.telemetry.activeVehicles = 2;
  // Without these the addon reports no player car, and a tape with no player
  // exercises almost nothing: fuel, gear, inputs and the whole player half of
  // the frame are skipped.
  snapshot.telemetry.playerHasVehicle = 1;
  snapshot.telemetry.playerVehicleIdx = 0;
  snapshot.scoring.scoringInfo.mLapDist = 7004.0;
  std::strncpy(
      snapshot.scoring.scoringInfo.mTrackName,
      "Synthetic Circuit",
      sizeof(snapshot.scoring.scoringInfo.mTrackName) - 1);

  for (std::uint32_t frame = 0; frame < options.frames; ++frame) {
    const double seconds = static_cast<double>(frame) / 100.0;
    snapshot.generic.events.SME_UPDATE_TELEMETRY = frame;
    snapshot.generic.events.SME_UPDATE_SCORING = frame / 20;
    snapshot.scoring.scoringInfo.mCurrentET = seconds;
    for (int car = 0; car < 2; ++car) {
      auto& scoring = snapshot.scoring.vehScoringInfo[car];
      scoring.mID = car;
      scoring.mIsPlayer = car == 0 ? 1 : 0;
      scoring.mPlace = static_cast<std::uint8_t>(car + 1);
      scoring.mLapDist = std::fmod(seconds * 60.0 + car * 100.0, 7004.0);
      scoring.mTotalLaps = static_cast<std::int32_t>(seconds / 90.0);
      auto& telemetry = snapshot.telemetry.telemInfo[car];
      telemetry.mID = car;
      telemetry.mElapsedTime = seconds;
      telemetry.mLapNumber = scoring.mTotalLaps;
      telemetry.mFuel = 40.0 - seconds * 0.01;
      telemetry.mFuelCapacity = 110.0;
      telemetry.mGear = 4;
      telemetry.mEngineRPM = 7000.0 + std::sin(seconds) * 1500.0;
      telemetry.mUnfilteredThrottle = 0.8;
      telemetry.mUnfilteredBrake = 0.0;
      // |mLocalVel| is the speed the lap-distance reconstruction integrates.
      telemetry.mLocalVel.z = -60.0;
    }

    if (!writer.appendSnapshot(
            snapshot, static_cast<std::uint64_t>(seconds * 1'000'000.0),
            error)) {
      std::cerr << error << "\n";
      return 1;
    }

    // Synthetic REST responses, so a fixture exercises the whole tape format
    // and not only its snapshots. Written on the first frame and then about
    // once a second, which is roughly how often a real body changes once the
    // poller's backoff has settled.
    if (frame == 0 || frame % 100 == 99) {
      const auto elapsed = static_cast<std::uint64_t>(seconds * 1'000'000.0);
      std::ostringstream pit;
      pit << "{\"total\":" << (32.0 + std::sin(seconds))
          << ",\"damage\":" << (12.0 + std::cos(seconds)) << "}";
      if (!writer.appendRest(
              "/rest/strategy/pitstop-estimate", pit.str(), elapsed, error)) {
        std::cerr << error << "\n";
        return 1;
      }

      std::ostringstream refuel;
      refuel << "{\"fuelInfo\":{\"maxVirtualEnergy\":100},"
             << "\"wearables\":{\"body\":{\"aero\":0.1},"
             << "\"brakes\":[1,1,1,1],\"suspension\":[1,1,1,1]},"
             << "\"pitMenu\":{\"pitMenu\":[{\"name\":\"FUEL:\","
             << "\"currentSetting\":0,\"settings\":[{\"text\":\"+"
             << (30.0 + static_cast<double>(frame) * 0.01) << " L\"}]}]}}";
      if (!writer.appendRest(
              "/rest/garage/UIScreen/RepairAndRefuel", refuel.str(), elapsed,
              error)) {
        std::cerr << error << "\n";
        return 1;
      }
    }
  }

  if (!writer.finish(error)) {
    std::cerr << error << "\n";
    return 1;
  }
  std::cout << "Wrote " << writer.recordCount() << " records to "
            << options.path << "\n";
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  std::string error;
  if (!parseOptions(argc, argv, options, error)) {
    std::cerr << error << "\n";
    return 2;
  }

  if (options.command == "record") return runRecord(options);
  if (options.command == "inspect") return runInspect(options);
  if (options.command == "fixture") return runFixture(options);

  std::cerr << "Unknown command: " << options.command << "\n";
  return 2;
}
