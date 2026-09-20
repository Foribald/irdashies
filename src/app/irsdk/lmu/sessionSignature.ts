import type { LmuRawSession } from '../native/lmu';

export const lmuSessionSignature = (session: LmuRawSession): string =>
  JSON.stringify({
    trackName: session.trackName,
    session: session.session,
    numVehicles: session.numVehicles,
    playerVehicleIdx: session.playerHasVehicle ? session.playerVehicleIdx : -1,
    lapDist: session.lapDist,
    gameVersion: session.gameVersion,
    cloudCoverage: session.cloudCoverage,
    wind: session.wind,
    raining: session.raining,
    maxPlayers: session.maxPlayers,
    maxLaps: session.maxLaps,
    isFixedSetup: session.isFixedSetup,
    engineMaxRPM: session.engineMaxRPM,
    fuelCapacity: session.fuelCapacity,
    maxGears: session.maxGears,
    frontTireCompoundName: session.frontTireCompoundName,
    drivers: session.drivers.map((driver) => ({
      id: driver.id,
      isPlayer: driver.isPlayer,
      name: driver.name,
      vehicleName: driver.vehicleName,
      vehicleModel: driver.vehicleModel,
      className: driver.className,
      vehFilename: driver.vehFilename,
      classId: driver.classId,
      // The running order is part of the session snapshot now, so a change of
      // position has to invalidate it. Without this an overtake would not
      // reach the standings until someone's lap time or lap count changed.
      place: driver.place,
      qualification: driver.qualification,
      bestLapTime: driver.bestLapTime,
      lastLapTime: driver.lastLapTime,
      totalLaps: driver.totalLaps,
      estimatedLapTime: driver.estimatedLapTime,
    })),
  });
