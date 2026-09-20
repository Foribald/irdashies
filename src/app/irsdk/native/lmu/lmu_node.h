#ifndef LMU_NODE_H
#define LMU_NODE_H

#include <napi.h>
#include <map>
#include <string>
#include "lmu_struct.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

class LmuSdkNode : public Napi::ObjectWrap<LmuSdkNode>
{
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    LmuSdkNode(const Napi::CallbackInfo &info);
    ~LmuSdkNode();

private:
    Napi::Value Start(const Napi::CallbackInfo &info);
    Napi::Value Stop(const Napi::CallbackInfo &info);
    Napi::Value IsRunning(const Napi::CallbackInfo &info);
    Napi::Value Read(const Napi::CallbackInfo &info);
    Napi::Value ReadSession(const Napi::CallbackInfo &info);
    Napi::Value FrameClock(const Napi::CallbackInfo &info);

    int GetClassId(const char *className) const;
    const LMUVehicleTelemetry *GetPlayerTelemetry() const;
    const LMUVehicleTelemetry *GetVehicleTelemetryById(int id) const;
    bool CaptureSnapshot();
    bool IsLive() const;
    int VehicleCount() const;
    void FillVehicleArrays(Napi::Object &out) const;
    void Unmap();

    HANDLE _hMap;
    uint8_t *_view;
    const LMUObjectOut *_mapped;
    LMUObjectOut _snapshot;
    bool _hasSnapshot;
    // SME_* values of the snapshot currently held. Exposed to JS for diagnosis
    // only: measured against a live LMU 14150, these never change, so they
    // cannot be used to detect a new frame.
    uint32_t _scoringUpdate;
    uint32_t _telemetryUpdate;
    // mElapsedTime of the snapshot currently held. This one was measured to
    // advance at 100 Hz, and is what makes eliding the copy safe. Negative when
    // there is no player car and so no clock to compare.
    double _frameClock;
    mutable std::map<std::string, int> _classIds;
};

#endif