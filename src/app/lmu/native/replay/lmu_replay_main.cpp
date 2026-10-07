// Records and inspects LMU shared-memory tapes.
//
// The LMU analogue of irsdk_replay. It is deliberately smaller: LMU publishes
// one fixed struct rather than iRacing's variable-header triple buffer, so a
// tape is a sequence of whole snapshots and there is no schema to carry.
//
// Playback is not here. The iRacing tool can republish into an isolated
// shared-memory mapping because the reader is the SDK; for LMU the reader is
// our own addon, so the tape is played in-process by lmu_tape_node instead.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <fstream>
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
  /**
   * The single path the one-path commands take, whichever flag named it.
   *
   * Kept so record, inspect and fixture read exactly as they did. anonymise is
   * the only command that needs two, and it uses the fields below.
   */
  std::string path;
  std::string inputPath;
  std::string outputPath;
  /** anonymise: the file of replacement names, one per line. */
  std::string namesPath;
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
    error =
        "Usage: lmu_replay <record|inspect|fixture|anonymise> [options]";
    return false;
  }
  options.command = argv[1];

  for (int i = 2; i < argc; ++i) {
    const std::string arg = argv[i];
    const bool hasNext = i + 1 < argc;
    if (arg == "--input" && hasNext) {
      options.inputPath = argv[++i];
      if (options.path.empty()) options.path = options.inputPath;
    } else if (arg == "--output" && hasNext) {
      options.outputPath = argv[++i];
      if (options.path.empty()) options.path = options.outputPath;
    } else if (arg == "--names" && hasNext) {
      options.namesPath = argv[++i];
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

  if (options.command == "anonymise") {
    if (options.inputPath.empty() || options.outputPath.empty()) {
      error = "anonymise needs both --input and --output";
      return false;
    }
    if (options.inputPath == options.outputPath) {
      // Rewriting in place would read from a file the writer has already
      // truncated, so the tape would be destroyed rather than anonymised.
      error = "--output must differ from --input";
      return false;
    }
    if (options.namesPath.empty()) {
      error = "anonymise needs --names, a file of replacement names";
      return false;
    }
  } else if (options.path.empty()) {
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
    "/rest/garage/UIScreen/CarSetupOverview",
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

/**
 * The longest name the sim's 32-byte fields hold, leaving room for the NUL.
 *
 * Replacements are truncated to it, because that is what the app would read
 * anyway -- truncating here means the tape never claims a name longer than it
 * can store.
 */
constexpr std::size_t kNameFieldLimit = 31;

std::string trim(const std::string& text) {
  const auto first = text.find_first_not_of(" \t");
  if (first == std::string::npos) return std::string();
  return text.substr(first, text.find_last_not_of(" \t") - first + 1);
}

/**
 * Reads a fixed-size char field as a string, stopping at the first NUL.
 *
 * The sim pads these buffers, so the size is the bound and the NUL only says
 * where the name ends inside it.
 */
std::string boundedString(const char* field, std::size_t size) {
  const std::size_t length =
      static_cast<std::size_t>(std::find(field, field + size, '\0') - field);
  return std::string(field, length);
}

/** Overwrites a fixed-size char field, NUL-padded and never overrunning. */
void writeBounded(char* field, std::size_t size, const std::string& value) {
  if (size == 0) return;
  std::memset(field, 0, size);
  std::memcpy(field, value.data(), std::min(value.size(), size - 1));
}

/**
 * Loads the replacement names.
 *
 * One name per line. A line may be a complete name ("Lewis Hamilton") or a
 * first and last name separated by a comma or a tab, which are joined with a
 * space -- so a list exported from a spreadsheet works unedited. Blank lines
 * and lines starting with '#' are ignored, so the file can be commented.
 */
bool loadNamePool(
    const std::string& path,
    std::vector<std::string>& pool,
    std::string& error) {
  std::ifstream stream(path);
  if (!stream) {
    error = "Failed to open names file: " + path;
    return false;
  }

  std::string line;
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const auto separator = line.find_first_of(",\t");
    if (separator != std::string::npos) {
      line = trim(line.substr(0, separator)) + " " +
             trim(line.substr(separator + 1));
    }
    line = trim(line);
    if (line.empty() || line.front() == '#') continue;
    if (line.size() > kNameFieldLimit) line.resize(kNameFieldLimit);
    line = trim(line);
    if (!line.empty()) pool.push_back(line);
  }

  if (pool.empty()) {
    error = "No usable names in " + path;
    return false;
  }
  return true;
}

/**
 * Hands out one pseudonym per real name, the same one every time.
 *
 * Keyed on the original name rather than on a vehicle id, which is what keeps
 * the result coherent: mPlayerName and the player's own mDriverName carry the
 * same string, so they get the same pseudonym without this having to know
 * which slot the player is in. A car that leaves and rejoins on another id
 * keeps its name for the same reason.
 *
 * Assignment is by order of first appearance, so one tape and one names file
 * always produce the same output.
 */
class NamePool {
 public:
  explicit NamePool(std::vector<std::string> names) : names_(std::move(names)) {}

  const std::string& pseudonymFor(const std::string& original) {
    const auto existing = assigned_.find(original);
    if (existing != assigned_.end()) return existing->second;

    // Past the end of the pool names repeat with a number appended rather
    // than collide: two drivers sharing a name in the standings reads as a
    // fault in the app rather than as a short list here.
    const std::size_t round = taken_ / names_.size();
    std::string name = names_[taken_ % names_.size()];
    if (round > 0) {
      const std::string suffix = " " + std::to_string(round + 1);
      if (name.size() + suffix.size() > kNameFieldLimit) {
        name.resize(kNameFieldLimit - suffix.size());
      }
      name += suffix;
    }
    ++taken_;
    return assigned_.emplace(original, std::move(name)).first->second;
  }

  const std::map<std::string, std::string>& assigned() const {
    return assigned_;
  }

 private:
  std::vector<std::string> names_;
  std::map<std::string, std::string> assigned_;
  std::size_t taken_ = 0;
};

/**
 * Every field in a snapshot that names a person, and what becomes of it.
 *
 * mPlrFileName is zeroed rather than renamed. It is the player's own
 * "<name>.PLR" on rF2-derived sims and nothing in the app reads it, so a tape
 * would otherwise carry a real name that no consumer could even be seen using.
 *
 * The scoring stream goes the same way for the same reason at larger scale:
 * 64 KB nothing reads, which on rF2 carries result lines with names in them.
 * Zeroing it costs nothing in the tape, since a constant buffer run-length
 * encodes away.
 *
 * mServerName is replaced rather than zeroed, so an anonymised tape can be
 * told apart from one recorded offline.
 */
void anonymiseSnapshot(LMUObjectOut& snapshot, NamePool& pool) {
  for (std::size_t i = 0; i < LMU_MAX_VEHICLES; ++i) {
    auto& vehicle = snapshot.scoring.vehScoringInfo[i];
    const std::string original =
        boundedString(vehicle.mDriverName, sizeof(vehicle.mDriverName));
    // An empty slot is not a person. Naming it would invent a driver the tape
    // never had, in a slot the mapper reads by occupancy.
    if (original.empty()) continue;
    writeBounded(
        vehicle.mDriverName,
        sizeof(vehicle.mDriverName),
        pool.pseudonymFor(original));
  }

  auto& info = snapshot.scoring.scoringInfo;
  const std::string player =
      boundedString(info.mPlayerName, sizeof(info.mPlayerName));
  if (!player.empty()) {
    writeBounded(
        info.mPlayerName, sizeof(info.mPlayerName), pool.pseudonymFor(player));
  }
  std::memset(info.mPlrFileName, 0, sizeof(info.mPlrFileName));
  writeBounded(info.mServerName, sizeof(info.mServerName), "SERVER");
  std::memset(
      snapshot.scoring.scoringStream,
      0,
      sizeof(snapshot.scoring.scoringStream));
  std::memset(
      snapshot.scoring.scoringStreamSize,
      0,
      sizeof(snapshot.scoring.scoringStreamSize));
}

/** Collects the names a snapshot carries, in order, without changing it. */
void collectNames(const LMUObjectOut& snapshot, std::vector<std::string>& out) {
  const auto remember = [&out](std::string name) {
    if (name.empty()) return;
    if (std::find(out.begin(), out.end(), name) == out.end()) {
      out.push_back(std::move(name));
    }
  };
  for (std::size_t i = 0; i < LMU_MAX_VEHICLES; ++i) {
    const auto& vehicle = snapshot.scoring.vehScoringInfo[i];
    remember(boundedString(vehicle.mDriverName, sizeof(vehicle.mDriverName)));
  }
  const auto& info = snapshot.scoring.scoringInfo;
  remember(boundedString(info.mPlayerName, sizeof(info.mPlayerName)));
}

/**
 * Rewrites a tape with every driver name replaced.
 *
 * A tape cannot be edited in place: names live inside run-length encoded
 * payloads, every record carries a checksum over its payload, and a delta is
 * an XOR against the frame before it. So each frame is decoded, patched and
 * re-encoded, and the writer recomputes the checksums.
 *
 * Two passes, the first reading only, so every name in the tape is known
 * before anything is written. That is what lets the REST bodies -- stored
 * verbatim, and not ours to parse -- be checked against the complete set
 * rather than against whatever had been seen by the time each came round.
 */
int runAnonymise(const Options& options) {
  std::vector<std::string> names;
  std::string error;
  if (!loadNamePool(options.namesPath, names, error)) {
    std::cerr << error << "\n";
    return 1;
  }

  TapeReader reader;
  if (!reader.open(options.inputPath, error)) {
    std::cerr << error << "\n";
    return 1;
  }

  TapeRecordHeader record{};
  LMUObjectOut snapshot{};
  std::string restPath;
  std::string restBody;

  std::vector<std::string> originals;
  while (true) {
    const auto result =
        reader.readNext(record, snapshot, restPath, restBody, error);
    if (result == TapeReadResult::EndOfFile) break;
    if (result == TapeReadResult::Error) {
      std::cerr << error << "\n";
      return 1;
    }
    const auto kind = static_cast<RecordKind>(record.kind);
    if (kind == RecordKind::Keyframe || kind == RecordKind::Delta) {
      collectNames(snapshot, originals);
    }
  }

  if (!reader.rewind(error)) {
    std::cerr << error << "\n";
    return 1;
  }

  NamePool pool(std::move(names));
  TapeWriter writer;
  if (!writer.open(options.outputPath, error)) {
    std::cerr << error << "\n";
    return 1;
  }

  std::uint64_t snapshots = 0;
  std::uint64_t disconnects = 0;
  std::uint64_t restRecords = 0;
  std::uint64_t restLeaks = 0;
  std::set<std::string> leakingPaths;
  while (true) {
    const auto result =
        reader.readNext(record, snapshot, restPath, restBody, error);
    if (result == TapeReadResult::EndOfFile) break;
    if (result == TapeReadResult::Error) {
      std::cerr << error << "\n";
      return 1;
    }

    bool ok = true;
    switch (static_cast<RecordKind>(record.kind)) {
      case RecordKind::Keyframe:
      case RecordKind::Delta:
        anonymiseSnapshot(snapshot, pool);
        ok = writer.appendSnapshot(snapshot, record.elapsedMicros, error);
        ++snapshots;
        break;
      case RecordKind::Disconnect:
        ok = writer.appendDisconnect(record.elapsedMicros, error);
        ++disconnects;
        break;
      case RecordKind::Rest:
        // Copied through: this is LMU's own JSON and rewriting it would mean
        // parsing a shape that changes between builds. Reported instead, so a
        // body that does carry a name is a decision rather than a surprise.
        for (const auto& original : originals) {
          if (original.size() >= 3 &&
              restBody.find(original) != std::string::npos) {
            ++restLeaks;
            leakingPaths.insert(restPath);
            break;
          }
        }
        ok = writer.appendRest(restPath, restBody, record.elapsedMicros, error);
        ++restRecords;
        break;
      default:
        break;
    }
    if (!ok) {
      std::cerr << error << "\n";
      return 1;
    }
  }

  if (!writer.finish(error)) {
    std::cerr << error << "\n";
    return 1;
  }

  std::cout << "Anonymised:      " << options.inputPath << "\n"
            << "Wrote:           " << options.outputPath << "\n"
            << "Snapshots:       " << snapshots << "\n"
            << "Disconnects:     " << disconnects << "\n"
            << "REST records:    " << restRecords << "\n"
            << "Names replaced:  " << pool.assigned().size() << "\n";
  for (const auto& entry : pool.assigned()) {
    std::cout << "  " << entry.first << " -> " << entry.second << "\n";
  }
  if (restLeaks > 0) {
    std::cout << "WARNING:         " << restLeaks
              << " REST record(s) still carry an original name:\n";
    for (const auto& path : leakingPaths) {
      std::cout << "  " << path << "\n";
    }
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
  // Names, so a fixture exercises the fields anonymise rewrites. The player's
  // own scoring entry carries the same string as mPlayerName, which is what
  // the real sim does and what anonymise relies on to keep the two in step.
  std::strncpy(
      snapshot.scoring.scoringInfo.mPlayerName,
      "Synthetic Player",
      sizeof(snapshot.scoring.scoringInfo.mPlayerName) - 1);
  std::strncpy(
      snapshot.scoring.scoringInfo.mPlrFileName,
      "Synthetic Player.PLR",
      sizeof(snapshot.scoring.scoringInfo.mPlrFileName) - 1);
  std::strncpy(
      snapshot.scoring.scoringInfo.mServerName,
      "Synthetic Server",
      sizeof(snapshot.scoring.scoringInfo.mServerName) - 1);

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
      std::strncpy(
          scoring.mDriverName,
          car == 0 ? "Synthetic Player" : "Synthetic Rival",
          sizeof(scoring.mDriverName) - 1);
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
  if (options.command == "anonymise") return runAnonymise(options);

  std::cerr << "Unknown command: " << options.command << "\n";
  return 2;
}
