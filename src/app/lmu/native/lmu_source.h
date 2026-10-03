#ifndef IRDASHIES_LMU_SOURCE_H
#define IRDASHIES_LMU_SOURCE_H

#include "lmu_struct.h"

namespace irdashies::lmu {

/**
 * Where LMU snapshots come from.
 *
 * The production addon reads the sim's shared memory; the replay addon reads a
 * recorded tape. Each build links exactly one implementation of this, so
 * everything above it -- every line that turns a snapshot into the JS objects
 * the app consumes -- is the same code either way, and a tape exercises the
 * real mapping rather than a stand-in for it.
 *
 * The same arrangement irsdk_node.cc has with irsdk_utils.cpp and
 * irsdk_tape_utils.cpp.
 */

/** Attaches to the source. Safe to call when already attached. */
bool sourceOpen();

/** Releases it. Safe to call when not attached. */
void sourceClose();

/**
 * Copies the next snapshot worth having, false when there is none.
 *
 * Shared memory returns false for a torn read; a tape returns false once it
 * has run out, or while it is waiting for the next frame's turn.
 */
bool sourceCapture(LMUObjectOut& out);

/**
 * Whether this snapshot represents a sim that is actually there.
 *
 * Shared memory checks the window handle the snapshot names is still a window.
 * A tape cannot: the window it recorded died with the session. So this is part
 * of the seam rather than something the addon can decide for itself.
 */
bool sourceIsLive(const LMUObjectOut& snapshot);

}  // namespace irdashies::lmu

#endif
