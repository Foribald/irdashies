// Standalone diagnostic: how often does LMU actually publish a frame?
//
// Reads only the sim's publish counters straight out of the mapped block, so it
// never copies the 325 KB payload and never disturbs anything. Answers the one
// question that decides whether a higher poll rate or a dedicated capture
// thread would buy anything: what is the real publish cadence, and what does a
// fixed-interval poll make of it.
//
// Build:  npm run irsdk:build   ->  build\Release\lmu_probe.exe
// Usage:  lmu_probe.exe [seconds]      (default 5)

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <vector>

#include "lmu_struct.h"

namespace {

const wchar_t *kSharedMemoryName = L"LMU_Data";

double MillisBetween(LARGE_INTEGER from, LARGE_INTEGER to, double freq) {
  return static_cast<double>(to.QuadPart - from.QuadPart) * 1000.0 / freq;
}

double Percentile(const std::vector<double> &sorted, double p) {
  if (sorted.empty()) return 0.0;
  size_t index = static_cast<size_t>(sorted.size() * p);
  if (index >= sorted.size()) index = sorted.size() - 1;
  return sorted[index];
}

// What a fixed-interval poll would have made of the arrivals we observed.
void ReplayPoll(const std::vector<double> &arrivals, double intervalMs) {
  size_t duplicates = 0;
  size_t dropped = 0;
  size_t ticks = 0;
  long long previous = -1;

  for (double t = arrivals.front(); t < arrivals.back(); t += intervalMs) {
    long long index = -1;
    for (size_t i = 0; i < arrivals.size() && arrivals[i] <= t; ++i) {
      index = static_cast<long long>(i);
    }
    ++ticks;
    if (index == previous) {
      ++duplicates;
    } else if (index - previous > 1) {
      dropped += static_cast<size_t>(index - previous - 1);
    }
    previous = index;
  }

  if (ticks == 0) return;
  const double dupPct = 100.0 * duplicates / ticks;
  const double dropPct = 100.0 * dropped / ticks;

  std::printf("\n=== a fixed %.0f ms poll over that stream ===\n", intervalMs);
  std::printf("ticks              %zu\n", ticks);
  std::printf("repeated frames    %zu (%.1f%%)  <- plot holds still\n",
              duplicates, dupPct);
  std::printf("dropped frames     %zu (%.1f%%)  <- plot jumps\n", dropped,
              dropPct);
  if (duplicates + dropped == 0) {
    std::printf("In step: the poll rate is not the problem.\n");
  } else {
    std::printf("%.1f%% of ticks are a repeat or a skip.\n", dupPct + dropPct);
  }
}

}  // namespace

int wmain(int argc, wchar_t **argv) {
  double seconds = 5.0;
  if (argc > 1) {
    const double requested = _wtof(argv[1]);
    if (requested >= 1.0 && requested <= 120.0) seconds = requested;
  }

  HANDLE map = OpenFileMappingW(FILE_MAP_READ, FALSE, kSharedMemoryName);
  if (map == NULL) {
    std::printf(
        "Could not open the LMU shared memory (\"LMU_Data\").\n\n"
        "Start LMU, enable Settings > Gameplay > Enable Plugins, restart the\n"
        "game, and get into a session before running this.\n");
    return 2;
  }

  const void *view = MapViewOfFile(map, FILE_MAP_READ, 0, 0, 0);
  if (view == NULL) {
    std::printf("Opened the shared memory but could not map it (error %lu).\n",
                GetLastError());
    CloseHandle(map);
    return 2;
  }

  MEMORY_BASIC_INFORMATION region = {};
  if (VirtualQuery(view, &region, sizeof(region)) == 0 ||
      region.RegionSize < sizeof(LMUObjectOut)) {
    std::printf(
        "The shared memory is smaller than expected (%zu bytes, need %zu).\n"
        "This build's struct layout does not match the running LMU version.\n",
        region.RegionSize, sizeof(LMUObjectOut));
    UnmapViewOfFile(view);
    CloseHandle(map);
    return 3;
  }

  const LMUObjectOut *lmu = reinterpret_cast<const LMUObjectOut *>(view);

  if (lmu->generic.gameVersion <= 0) {
    std::printf("LMU is mapped but not publishing (gameVersion is 0).\n");
    UnmapViewOfFile(view);
    CloseHandle(map);
    return 2;
  }

  LARGE_INTEGER frequency = {};
  QueryPerformanceFrequency(&frequency);
  const double freq = static_cast<double>(frequency.QuadPart);

  std::printf("Watching LMU for %.0f s -- keep the car on track.\n", seconds);
  std::printf("game version %d, timer resolution %.3f us\n\n",
              lmu->generic.gameVersion, 1e6 / freq);

  LARGE_INTEGER start = {};
  QueryPerformanceCounter(&start);

  std::vector<double> telemetryArrivals;
  std::vector<double> scoringArrivals;
  telemetryArrivals.reserve(64 * 1024);
  scoringArrivals.reserve(64 * 1024);

  unsigned long long polls = 0;
  uint32_t lastTelemetry = 0;
  uint32_t lastScoring = 0;
  bool first = true;

  // Counts sampled whenever they disagree, which is the condition that used to
  // be misread as a torn read and surfaced as a false disconnect.
  long long mismatchPolls = 0;
  int minScoringVehicles = 1 << 30;
  int maxScoringVehicles = -1;
  int minTelemetryVehicles = 1 << 30;
  int maxTelemetryVehicles = -1;

  for (;;) {
    LARGE_INTEGER now = {};
    QueryPerformanceCounter(&now);
    const double elapsed = MillisBetween(start, now, freq);
    if (elapsed >= seconds * 1000.0) break;

    // Direct reads. No copy, no lock, nothing the sim can notice.
    const uint32_t telemetryUpdate = lmu->generic.events.SME_UPDATE_TELEMETRY;
    const uint32_t scoringUpdate = lmu->generic.events.SME_UPDATE_SCORING;
    const int scoringVehicles = lmu->scoring.scoringInfo.mNumVehicles;
    const int telemetryVehicles = lmu->telemetry.activeVehicles;
    ++polls;

    if (scoringVehicles != telemetryVehicles) ++mismatchPolls;
    minScoringVehicles = (std::min)(minScoringVehicles, scoringVehicles);
    maxScoringVehicles = (std::max)(maxScoringVehicles, scoringVehicles);
    minTelemetryVehicles = (std::min)(minTelemetryVehicles, telemetryVehicles);
    maxTelemetryVehicles = (std::max)(maxTelemetryVehicles, telemetryVehicles);

    if (first || telemetryUpdate != lastTelemetry) {
      telemetryArrivals.push_back(elapsed);
      lastTelemetry = telemetryUpdate;
    }
    if (first || scoringUpdate != lastScoring) {
      scoringArrivals.push_back(elapsed);
      lastScoring = scoringUpdate;
    }
    first = false;
  }

  UnmapViewOfFile(view);
  CloseHandle(map);

  if (telemetryArrivals.size() < 3) {
    std::printf(
        "Only %zu telemetry frame(s) in %.0f s.\n"
        "Is the session paused, or the car in a menu or the garage?\n",
        telemetryArrivals.size(), seconds);
    return 4;
  }

  std::vector<double> gaps;
  gaps.reserve(telemetryArrivals.size());
  for (size_t i = 1; i < telemetryArrivals.size(); ++i) {
    gaps.push_back(telemetryArrivals[i] - telemetryArrivals[i - 1]);
  }
  std::vector<double> sorted = gaps;
  std::sort(sorted.begin(), sorted.end());
  double total = 0.0;
  for (double gap : gaps) total += gap;

  std::printf("=== what LMU publishes ===\n");
  std::printf("polls              %llu (%.0f/s)\n", polls,
              static_cast<double>(polls) / seconds);
  std::printf("telemetry frames   %zu -> %.1f Hz\n", telemetryArrivals.size(),
              telemetryArrivals.size() / seconds);
  std::printf("scoring frames     %zu -> %.1f Hz\n", scoringArrivals.size(),
              scoringArrivals.size() / seconds);
  std::printf("wasted polls       %.1f%% saw nothing new\n",
              100.0 * (polls - telemetryArrivals.size()) / polls);
  std::printf(
      "frame gap          median %.2f ms | mean %.2f | p10 %.2f | p90 %.2f | "
      "max %.2f\n",
      Percentile(sorted, 0.5), total / gaps.size(), Percentile(sorted, 0.1),
      Percentile(sorted, 0.9), sorted.back());

  std::printf("\n=== vehicle counts ===\n");
  std::printf("scoring            %d..%d\n", minScoringVehicles,
              maxScoringVehicles);
  std::printf("telemetry          %d..%d\n", minTelemetryVehicles,
              maxTelemetryVehicles);
  std::printf("disagreed on       %.1f%% of polls%s\n",
              100.0 * mismatchPolls / static_cast<double>(polls),
              mismatchPolls > 0 ? "  <- legitimate; not a torn read" : "");

  ReplayPoll(telemetryArrivals, 16.0);
  ReplayPoll(telemetryArrivals, 8.0);

  std::printf(
      "\nThe counter gate already removes the cost of the repeated frames.\n"
      "A capture thread is only worth building if the dropped-frame share\n"
      "stays high at 8 ms.\n");
  return 0;
}
