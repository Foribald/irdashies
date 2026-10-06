import { RadioInfo } from './radio-info';
import { CameraInfo } from './camera-info';
import { SessionList, SessionResultsPosition } from './session-info';
import { WeekendInfo } from './weekend-info';
import { DriverInfo } from './driver-info';
import { SplitTimeInfo } from './split-info';
import { CarSetupInfo } from './setup-info';

export interface LmuTrackMap {
  orientation?: 'lmu-ccw-v1';
  active: {
    inside: string;
    outside: string;
    trackPathPoints: { x: number; y: number }[];
    totalLength: number;
  };
  startFinish: {
    line: string;
    point: { x: number; y: number; length: number };
    direction: 'anticlockwise';
  };
  turns?: {
    x?: number;
    y?: number;
    content?: string;
  }[];
}

/** One point on LMU's weather forecast for a session. */
export interface LmuWeatherNode {
  /** Where in the session this applies, as a fraction of its length, 0..1. */
  start: number;
  /** LMU's sky type index, 0..10. */
  skyType: number;
  /** Degrees Celsius. */
  temperature: number;
  /** Chance of rain as a fraction, 0..1. */
  rainChance: number;
}

/**
 * Session values LMU serves over its local REST API rather than shared memory.
 *
 * One namespaced object rather than fields scattered across SessionData, the
 * same way LmuTrackMap is carried: a later addition touches nothing outside
 * this interface. Every field optional, like Driver.CarIsAIControlled -- the
 * established way to say "only some sims report this".
 */
export interface LmuRestSession {
  /** Race time multiplier. A scaled session makes real-time projections wrong. */
  timeScale?: number;
  privateQualifying?: boolean;
  /**
   * The car's virtual-energy budget. Hypercars and LMDh are energy-limited
   * rather than fuel-limited, so this is the denominator that matters; the
   * numerator is mVirtualEnergy from shared memory.
   */
  maxVirtualEnergy?: number;
  forecast?: {
    practice?: LmuWeatherNode[];
    qualify?: LmuWeatherNode[];
    race?: LmuWeatherNode[];
  };
}

/**
 * Information about the current session, stored as yaml.
 * Does not update as much as telemetry.
 * @todo the CarSetup types are incomplete. Help wanted!
 */
export interface SessionData {
  WeekendInfo: WeekendInfo;
  SessionInfo: SessionList;
  CameraInfo: CameraInfo;
  RadioInfo: RadioInfo;
  DriverInfo: DriverInfo;
  SplitTimeInfo: SplitTimeInfo;
  CarSetup: CarSetupInfo;
  QualifyResultsInfo?: { Results: SessionResultsPosition[] | null };
  LmuTrackMap?: LmuTrackMap;
  LmuRest?: LmuRestSession;
}
