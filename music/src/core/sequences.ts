/**
 * A library for common manipulations of `NoteSequence`s.
 *
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Imports
 */
import {INoteSequence, NoteSequence} from '../protobuf/index';

import * as constants from './constants';

// Set the quantization cutoff.
// Note events before this cutoff are rounded down to nearest step. Notes
// above this cutoff are rounded up to nearest step. The cutoff is given as a
// fraction of a step.
// For example, with quantize_cutoff = 0.75 using 0-based indexing,
// if .75 < event <= 1.75, it will be quantized to step 1.
// If 1.75 < event <= 2.75 it will be quantized to step 2.
// A number close to 1.0 gives less wiggle room for notes that start early,
// and they will be snapped to the previous step.
const QUANTIZE_CUTOFF = 0.5;

export class MultipleTimeSignatureException extends Error {
  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class BadTimeSignatureException extends Error {
  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class NegativeTimeException extends Error {
  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class MultipleTempoException extends Error {
  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Exception for when a sequence was unexpectedly quantized or unquantized.
 *
 * Should not happen during normal operation and likely indicates a programming
 * error.
 */
export class QuantizationStatusException extends Error {
  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isPowerOf2(n: number): boolean {
  return n && (n & (n - 1)) === 0;
}

export function clone(ns: INoteSequence) {
  return NoteSequence.decode(NoteSequence.encode(ns).finish());
}

/**
 * Calculates steps per second given stepsPerQuarter and a QPM.
 */
export function stepsPerQuarterToStepsPerSecond(
    stepsPerQuarter: number, qpm: number): number {
  return stepsPerQuarter * qpm / 60.0;
}

/**
 * Quantizes seconds to the nearest step, given steps_per_second.
 * See the comments above `QUANTIZE_CUTOFF` for details on how the
 * quantizing algorithm works.
 * @param unquantizedSeconds Seconds to quantize.
 * @param stepsPerSecond Quantizing resolution.
 * @param quantizeCutoff Value to use for quantizing cutoff.
 * @returns the quantized step.
 */
export function quantizeToStep(
    unquantizedSeconds: number, stepsPerSecond: number,
    quantizeCutoff = QUANTIZE_CUTOFF): number {
  const unquantizedSteps = unquantizedSeconds * stepsPerSecond;
  return Math.floor(unquantizedSteps + (1 - quantizeCutoff));
}

/**
 * Returns a list of events with a `time` and `quantizedStep` properties.
 */
function getQuantizedTimeEvents(ns: INoteSequence) {
  return ns.controlChanges.concat(ns.textAnnotations);
}

/**
 * Quantize the notes and events of a NoteSequence proto in place.
 * Note start and end times, and chord times are snapped to a nearby
 * quantized step, and the resulting times are stored in a separate field
 * (e.g. QuantizedStartStep). See the comments above `QUANTIZE_CUTOFF` for
 * details on how the quantizing algorithm works.
 * @param ns A `NoteSequence` to quantize. Will be modified in place.
 * @param stepsPerSecond Each second will be divided into this many
 * quantized time steps.
 */
function quantizeNotesAndEvents(ns: INoteSequence, stepsPerSecond: number) {
  for (const note of ns.notes) {
    // Quantize the start and end times of the note.
    note.quantizedStartStep = quantizeToStep(note.startTime, stepsPerSecond);
    note.quantizedEndStep = quantizeToStep(note.endTime, stepsPerSecond);
    if (note.quantizedEndStep === note.quantizedStartStep) {
      note.quantizedEndStep += 1;
    }

    // Do not allow notes to start or end in negative time.
    if (note.quantizedStartStep < 0 || note.quantizedEndStep < 0) {
      throw new NegativeTimeException(
          `Got negative note time: start_step = ` +
          `${note.quantizedStartStep}, end_step = ` +
          `${note.quantizedEndStep}`);
    }

    // Extend quantized sequence if necessary.
    if (note.quantizedEndStep > ns.totalQuantizedSteps) {
      ns.totalQuantizedSteps = note.quantizedEndStep;
    }
  }

  // Also quantize control changes and text annotations.
  getQuantizedTimeEvents(ns).forEach(event => {
    // Quantize the event time, disallowing negative time.
    event.quantizedStep = quantizeToStep(event.time, stepsPerSecond);
    if (event.quantizedStep < 0) {
      throw new NegativeTimeException(
          `Got negative event time: step = ${event.quantizedStep}`);
    }
  });
}

/**
 * Confirms there is no tempo change.
 */
function assertSingleTempo(ns: INoteSequence) {
  if (!ns.tempos || ns.tempos.length === 0) {
    // There is a single (implicit) tempo.
    return;
  }
  ns.tempos.sort((a, b) => a.time - b.time);
  // There is an implicit 120.0 qpm tempo at 0 time. So if the first tempo
  // is something other that 120.0 and it's at a time other than 0, that's
  // an implicit tempo change.
  if (ns.tempos[0].time !== 0 &&
      ns.tempos[0].qpm !== constants.DEFAULT_QUARTERS_PER_MINUTE) {
    throw new MultipleTempoException(
        'NoteSequence has an implicit tempo change from initial ' +
        `${constants.DEFAULT_QUARTERS_PER_MINUTE} qpm to ` +
        `${ns.tempos[0].qpm} qpm at ${ns.tempos[0].time} seconds.`);
  }

  for (let i = 1; i < ns.tempos.length; i++) {
    if (ns.tempos[i].qpm !== ns.tempos[0].qpm) {
      throw new MultipleTempoException(
          'NoteSequence has at least one tempo change from ' +
          `${ns.tempos[0].qpm} qpm to ${ns.tempos[i].qpm}` +
          `qpm at ${ns.tempos[i].time} seconds.`);
    }
  }
}

/**
 * Quantize a NoteSequence proto relative to tempo.
 *
 * The input NoteSequence is copied and quantization-related fields are
 * populated. Sets the `steps_per_quarter` field in the `quantization_info`
 * message in the NoteSequence.
 *
 * Note start and end times, and chord times are snapped to a nearby quantized
 * step, and the resulting times are stored in a separate field (e.g.,
 * QuantizedStartStep). See the comments above `QUANTIZE_CUTOFF` for details
 * on how the quantizing algorithm works.
 *
 * @param ns The `NoteSequence` to quantize.
 * @param stepsPerQuarter Each quarter note of music will be divided into
 *    this many quantized time steps.
 * @returns A copy of the original NoteSequence, with quantized times added.
 *
 * @throws {MultipleTempoException} If there is a change in tempo in
 * the sequence.
 * @throws {MultipleTimeSignatureException} If there is a change in time
 * signature in the sequence.
 * @throws {BadTimeSignatureException} If the time signature found in
 * the sequence has a 0 numerator or a denominator which is not a power of 2.
 * @throws {NegativeTimeException} If a note or chord occurs at a negative
 * time.
 */
export function quantizeNoteSequence(
    ns: INoteSequence, stepsPerQuarter: number): NoteSequence {
  // Make a copy.
  const qns = clone(ns);

  qns.quantizationInfo =
      NoteSequence.QuantizationInfo.create({stepsPerQuarter});

  if (qns.timeSignatures.length > 0) {
    qns.timeSignatures.sort((a, b) => a.time - b.time);
    // There is an implicit 4/4 time signature at 0 time. So if the first time
    // signature is something other than 4/4 and it's at a time other than 0,
    // that's an implicit time signature change.
    if (qns.timeSignatures[0].time !== 0 &&
        !(qns.timeSignatures[0].numerator === 4 &&
          qns.timeSignatures[0].denominator === 4)) {
      throw new MultipleTimeSignatureException(
          'NoteSequence has an implicit change from initial 4/4 time ' +
          `signature to ${qns.timeSignatures[0].numerator}/` +
          `${qns.timeSignatures[0].denominator} at ` +
          `${qns.timeSignatures[0].time} seconds.`);
    }

    for (let i = 1; i < qns.timeSignatures.length; i++) {
      const timeSignature = qns.timeSignatures[i];
      if (timeSignature.numerator !== qns.timeSignatures[0].numerator ||
          timeSignature.denominator !== qns.timeSignatures[0].denominator) {
        throw new MultipleTimeSignatureException(
            'NoteSequence has at least one time signature change from ' +
            `${qns.timeSignatures[0].numerator}/` +
            `${qns.timeSignatures[0].denominator} to ` +
            `${timeSignature.numerator}/${timeSignature.denominator} ` +
            `at ${timeSignature.time} seconds`);
      }
    }

    // Make it clear that there is only 1 time signature and it starts at the
    // beginning.
    qns.timeSignatures[0].time = 0;
    qns.timeSignatures = [qns.timeSignatures[0]];
  } else {
    const timeSignature = NoteSequence.TimeSignature.create(
        {numerator: 4, denominator: 4, time: 0});
    qns.timeSignatures.push(timeSignature);
  }

  const firstTS = qns.timeSignatures[0];
  if (!isPowerOf2(firstTS.denominator)) {
    throw new BadTimeSignatureException(
        'Denominator is not a power of 2. Time signature: ' +
        `${firstTS.numerator}/${firstTS.denominator}`);
  }

  if (firstTS.numerator === 0) {
    throw new BadTimeSignatureException(
        'Numerator is 0. Time signature: ' +
        `${firstTS.numerator}/${firstTS.denominator}`);
  }

  if (qns.tempos.length > 0) {
    assertSingleTempo(qns);

    // Make it clear that there is only 1 tempo and it starts at the beginning
    qns.tempos[0].time = 0;
    qns.tempos = [qns.tempos[0]];
  } else {
    const tempo = NoteSequence.Tempo.create(
        {qpm: constants.DEFAULT_QUARTERS_PER_MINUTE, time: 0});
    qns.tempos.push(tempo);
  }

  // Compute quantization steps per second.
  const stepsPerSecond =
      stepsPerQuarterToStepsPerSecond(stepsPerQuarter, qns.tempos[0].qpm);

  qns.totalQuantizedSteps = quantizeToStep(ns.totalTime, stepsPerSecond);
  quantizeNotesAndEvents(qns, stepsPerSecond);

  // return qns
  return qns;
}

/**
 * Returns whether or not a NoteSequence proto has been quantized.
 */
export function isQuantizedSequence(ns: INoteSequence) {
  return ns.quantizationInfo &&
      (ns.quantizationInfo.stepsPerQuarter > 0 ||
       ns.quantizationInfo.stepsPerSecond > 0);
}

/**
 * Confirms that the given NoteSequence has been quantized.
 */
export function assertIsQuantizedSequence(ns: INoteSequence) {
  if (!isQuantizedSequence(ns)) {
    throw new QuantizationStatusException(
        `NoteSequence ${ns.id} is not quantized (missing quantizationInfo)`);
  }
}

/**
 * Returns whether the given NoteSequence has been quantized relative to tempo.
 */
export function isRelativeQuantizedSequence(ns: INoteSequence) {
  return ns.quantizationInfo && ns.quantizationInfo.stepsPerQuarter > 0;
}

/**
 * Confirms that the given NoteSequence has been quantized relative to tempo.
 */
export function assertIsRelativeQuantizedSequence(ns: INoteSequence) {
  if (!isRelativeQuantizedSequence(ns)) {
    throw new QuantizationStatusException(`NoteSequence ${
        ns.id} is not quantized or is quantized based on absolute timing`);
  }
}

/**
 * Returns whether the given NoteSequence has been quantized by absolute time.
 */
export function isAbsoluteQuantizedSequence(ns: INoteSequence) {
  return ns.quantizationInfo && ns.quantizationInfo.stepsPerSecond > 0;
}

/**
 * Confirms that the given NoteSequence has been quantized by absolute time.
 */
export function assertIsAbsoluteQuantizedSequence(ns: INoteSequence) {
  if (!isAbsoluteQuantizedSequence(ns)) {
    throw new QuantizationStatusException(`NoteSequence ${
        ns.id} is not quantized or is quantized based on relative timing`);
  }
}

/**
 * Create an unquantized version of a quantized `NoteSequence`.
 *
 * Any existing times will be replaced in the output `NoteSequence` and
 * quantization info and steps will be removed.
 *
 * @param ns The `NoteSequence` to unquantize.
 * @param qpm The tempo to use. If not provided, the tempo in `ns` is used,
 * or the default of 120 if it is not specified in the sequence either.
 * @returns a new non-quantized `NoteSequence` with time in seconds.
 */
export function unquantizeSequence(qns: INoteSequence, qpm?: number) {
  // TODO(adarob): Support absolute quantized times and multiple tempos.
  assertIsRelativeQuantizedSequence(qns);
  assertSingleTempo(qns);

  const ns = clone(qns);

  if (qpm) {
    if (ns.tempos && ns.tempos.length > 0) {
      ns.tempos[0].qpm = qpm;
    } else {
      ns.tempos.push(NoteSequence.Tempo.create({time: 0, qpm}));
    }
  } else {
    qpm = (qns.tempos && qns.tempos.length > 0) ?
        ns.tempos[0].qpm :
        constants.DEFAULT_QUARTERS_PER_MINUTE;
  }

  const stepToSeconds = (step: number) =>
      step / ns.quantizationInfo.stepsPerQuarter * (60 / qpm);
  ns.totalTime = stepToSeconds(ns.totalQuantizedSteps);
  ns.notes.forEach(n => {
    // Quantize the start and end times of the note.
    n.startTime = stepToSeconds(n.quantizedStartStep);
    n.endTime = stepToSeconds(n.quantizedEndStep);
    // Extend sequence if necessary.
    ns.totalTime = Math.max(ns.totalTime, n.endTime);

    // Delete the quantized step information.
    delete n.quantizedStartStep;
    delete n.quantizedEndStep;
  });

  // Also quantize control changes and text annotations.
  getQuantizedTimeEvents(ns).forEach(event => {
    // Quantize the event time, disallowing negative time.
    event.time = stepToSeconds(event.time);
  });
  delete ns.totalQuantizedSteps;
  delete ns.quantizationInfo;
  return ns;
}

/**
 * Create an empty quantized NoteSequence with steps per quarter note and tempo.
 * @param stepsPerQuarter The number of steps per quarter note to use.
 * @param qpm The tempo to use.
 * @returns A new quantized NoteSequence.
 */
export function createQuantizedNoteSequence(
    stepsPerQuarter = constants.DEFAULT_STEPS_PER_QUARTER,
    qpm = constants.DEFAULT_QUARTERS_PER_MINUTE): NoteSequence {
  return NoteSequence.create(
      {quantizationInfo: {stepsPerQuarter}, tempos: [{qpm}]});
}

/**
 * Assign instruments to the notes, pitch bends, and control changes of a
 * `NoteSequence` based on program numbers and drum status. All drums will be
 * assigned the last instrument (and program 0). All non-drum events with the
 * same program number will be assigned to a single instrument.
 * @param ns The `NoteSequence` for which to merge instruments. Will not be
 * modified.
 * @returns A copy of `ns` with merged instruments.
 */
export function mergeInstruments(ns: INoteSequence) {
  const result = clone(ns);

  const events =
      result.notes.concat(result.pitchBends).concat(result.controlChanges);
  const programs =
      Array.from(new Set(events.filter(e => !e.isDrum).map(e => e.program)));

  events.forEach(e => {
    if (e.isDrum) {
      e.program = 0;
      e.instrument = programs.length;
    } else {
      e.instrument = programs.indexOf(e.program);
    }
  });

  return result;
}

/**
 * Replaces all the notes in an input sequence that match the instruments in
 * a second sequence. For example, if `replaceSequence` has notes that all have
 * either `instrument=0` or `instrument=1`, then any notes in `originalSequence`
 * with instruments 0 or 1 will be removed and replaced with the notes in
 * `replaceSequence`. If there are instruments in `replaceSequence` that are
 * *not* in `originalSequence`, they will not be added.
 * @param originalSequence The `NoteSequence` to be changed.
 * @param replaceSequence The `NoteSequence` that will replace the notes in
 * `sequence` with the same instrument.
 * @return a new `NoteSequence` with the instruments replaced.
 */
export function replaceInstruments(
    originalSequence: INoteSequence,
    replaceSequence: INoteSequence): NoteSequence {
  const instrumentsInOriginal =
      new Set(originalSequence.notes.map(n => n.instrument));
  const instrumentsInReplace =
      new Set(replaceSequence.notes.map(n => n.instrument));

  const newNotes: NoteSequence.Note[] = [];
  // Go through the original sequence, and only keep the notes for instruments
  // *not* in the second sequence.
  originalSequence.notes.forEach(n => {
    if (!instrumentsInReplace.has(n.instrument)) {
      newNotes.push(NoteSequence.Note.create(n));
    }
  });
  // Go through the second sequence and add all the notes for instruments in the
  // first sequence.
  replaceSequence.notes.forEach(n => {
    if (instrumentsInOriginal.has(n.instrument)) {
      newNotes.push(NoteSequence.Note.create(n));
    }
  });

  // Sort the notes by instrument, and then by time.
  const output = clone(originalSequence);
  output.notes = newNotes.sort((a, b) => {
    const voiceCompare = a.instrument - b.instrument;
    if (voiceCompare) {
      return voiceCompare;
    }
    return a.quantizedStartStep - b.quantizedStartStep;
  });
  return output;
}

/**
 * Any consecutive notes of the same pitch are merged into a sustained note.
 * Does not merge notes that connect on a measure boundary. This process
 * also rearranges the order of the notes - notes are grouped by instrument,
 * then ordered by timestamp.
 *
 * @param sequence A quantized `NoteSequence` to be merged.
 * @return a new `NoteSequence` with sustained notes merged.
 */
export function mergeConsecutiveNotes(sequence: INoteSequence) {
  assertIsQuantizedSequence(sequence);

  const output = clone(sequence);
  output.notes = [];

  // Sort the input notes.
  const newNotes = sequence.notes.sort((a, b) => {
    const voiceCompare = a.instrument - b.instrument;
    if (voiceCompare) {
      return voiceCompare;
    }
    return a.quantizedStartStep - b.quantizedStartStep;
  });

  // Start with the first note.
  const note = new NoteSequence.Note();
  note.pitch = newNotes[0].pitch;
  note.instrument = newNotes[0].instrument;
  note.quantizedStartStep = newNotes[0].quantizedStartStep;
  note.quantizedEndStep = newNotes[0].quantizedEndStep;
  output.notes.push(note);
  let o = 0;

  for (let i = 1; i < newNotes.length; i++) {
    const thisNote = newNotes[i];
    const previousNote = output.notes[o];
    // Compare next note's start time with previous note's end time.
    if (previousNote.instrument === thisNote.instrument &&
        previousNote.pitch === thisNote.pitch &&
        thisNote.quantizedStartStep === previousNote.quantizedEndStep &&
        // Doesn't start on the measure boundary.
        thisNote.quantizedStartStep % 16 !== 0) {
      // If the next note has the same pitch as this note and starts at the
      // same time as the previous note ends, absorb the next note into the
      // previous output note.
      output.notes[o].quantizedEndStep +=
          thisNote.quantizedEndStep - thisNote.quantizedStartStep;
    } else {
      // Otherwise, append the next note to the output notes.
      const note = new NoteSequence.Note();
      note.pitch = newNotes[i].pitch;
      note.instrument = newNotes[i].instrument;
      note.quantizedStartStep = newNotes[i].quantizedStartStep;
      note.quantizedEndStep = newNotes[i].quantizedEndStep;
      output.notes.push(note);
      o++;
    }
  }
  return output;
}

/**
 * Create a new NoteSequence with sustain pedal control changes applied.
 *
 * Extends each note within a sustain to either the beginning of the next
 * note of the same pitch or the end of the sustain period, whichever happens
 * first. This is done on a per instrument basis, so notes are only affected
 * by sustain events for the same instrument. Drum notes will not be
 * modified.
 *
 * @param noteSequence The NoteSequence for which to apply sustain. This
 * object will not be modified.
 * @param sustainControlNumber The MIDI control number for sustain pedal.
 * Control events with this number and value 0-63 will be treated as sustain
 * pedal OFF events, and control events with this number and value 64-127
 * will be treated as sustain pedal ON events.
 * @returns A copy of `note_sequence` but with note end times extended to
 * account for sustain.
 *
 * @throws {Error}: If `note_sequence` is quantized.
 * Sustain can only be applied to unquantized note sequences.
 */

export function applySustainControlChanges(
  noteSequence: INoteSequence, sustainControlNumber = 64): NoteSequence {

  enum MessageType {
    SUSTAIN_ON,
    SUSTAIN_OFF,
    NOTE_ON,
    NOTE_OFF
  }
  const isQuantized = isQuantizedSequence(noteSequence);
  if (isQuantized) {
    throw new Error('Can only apply sustain to unquantized NoteSequence.');
  }

  const sequence = clone(noteSequence);

  // Sort all note on/off and sustain on/off events.
  const events: Array<{ time: number, type: MessageType,
    event:{
      instrument?: number,
      pitch?: number
    } }> = [];
  for (const note of sequence.notes) {
    if (note.isDrum === false) {
      if (note.startTime !== null) {
        events.push({
          time: note.startTime,
          type: MessageType.NOTE_ON,
          event: note
        });
      }
      if (note.endTime !== null) {
        events.push({
          time: note.endTime,
          type: MessageType.NOTE_OFF,
          event: note
        });
      }
    }
  }
  for (const cc of sequence.controlChanges) {
    if (cc.controlNumber === sustainControlNumber) {
      const value = cc.controlValue;
      if ( (value < 0) || (value > 127) ) {
        // warning: out of range
      }
      if (value >= 64) {
        events.push({
          time: cc.time,
          type: MessageType.SUSTAIN_ON,
          event: cc
        });
      } else if (value < 64) {
        events.push({
          time: cc.time,
          type: MessageType.SUSTAIN_OFF,
          event: cc
        });
      }
    }
  }

  // Sort, using the time and event type constants to ensure the order events
  // are processed.
  events.sort((a,b) => a.time-b.time );

  // Lists of active notes, keyed by instrument.
  const activeNotes: { [key: number]: NoteSequence.INote[] } = {};
  // Whether sustain is active for a given instrument.
  const susActive: { [key: number]: boolean } = {};
  // Iterate through all sustain on/off and note on/off events in order.
  let time = 0;
  for (const item of events) {
    time = item.time;
    const type = item.type;
    const event = item.event;

    if (type === MessageType.SUSTAIN_ON) {
      susActive[event.instrument] = true;
    } else if (type === MessageType.SUSTAIN_OFF) {
      susActive[event.instrument] = false;
      // End all notes for the instrument that were being extended.
      const newActiveNotes: NoteSequence.INote[] = [];
      if (!(event.instrument in activeNotes)) {
        activeNotes[event.instrument] = [];
      }
      for (const note of activeNotes[event.instrument]) {
        if (note.endTime < time) {
          // This note was being extended because of sustain.
          // Update the end time and don't keep it in the list.
          note.endTime = time;
          if (time > sequence.totalTime) {
            sequence.totalTime = time;
          }
        } else {
          // This note is actually still active, keep it.
          newActiveNotes.push(note);
        }
      }
      activeNotes[event.instrument] = newActiveNotes;
    } else if (type === MessageType.NOTE_ON) {
      if (susActive[event.instrument] === true) {
        // If sustain is on, end all previous notes with the same pitch.
        const newActiveNotes: NoteSequence.INote[] = [];
        if (!(event.instrument in activeNotes)) {
          activeNotes[event.instrument] = [];
        }
        for (const note of activeNotes[event.instrument]) {
          if (note.pitch === event.pitch) {
            note.endTime = time;
            if (note.startTime === note.endTime) {
              // This note now has no duration because another note of the
              // same pitch started at the same time. Only one of these
              // notes should be preserved, so delete this one.
              sequence.notes.push(note);
            }
          } else {
            newActiveNotes.push(note);
          }
        }
        activeNotes[event.instrument] = newActiveNotes;
      }
      // Add this new note to the list of active notes.
      if (!(event.instrument in activeNotes)) {
        activeNotes[event.instrument] = [];
      }
      activeNotes[event.instrument].push(event);
    } else if (type === MessageType.NOTE_OFF) {
      if (susActive[event.instrument] === true) {
      //pass
      } else {
        // Remove this particular note from the active list.
        // It may have already been removed if a note of the same pitch was
        // played when sustain was active.
        const index = activeNotes[event.instrument].indexOf(event);
        if (index > -1) {
          activeNotes[event.instrument].splice(index, 1);
        }
      }
    }
  }
  // End any notes that were still active due to sustain.
  for (const instrument of Object.values(activeNotes)) {
    for (const note of instrument) {
      note.endTime = time;
      sequence.totalTime = time;
    }
  }
  return sequence;
}

/*
 * Concatenate a series of NoteSequences together.
 *
 * Individual sequences will be shifted and then merged together.
 * @param concatenateSequences An array of `NoteSequences` to be concatenated.
 * @param sequenceDurations (Optional) An array of durations for each of the
 * `NoteSequences` in `args`. If not provided, the `totalTime` /
 * `totalQuantizedSteps` of each sequence will be used. Specifying durations is
 * useful if the sequences to be concatenated are effectively longer than
 * their `totalTime` (e.g., a sequence that ends with a rest).
 *
 * @returns A new sequence that is the result of concatenating the input
 * sequences.
 */
export function concatenate(
    concatenateSequences: INoteSequence[],
    sequenceDurations?: number[]): NoteSequence {
  if (sequenceDurations &&
      sequenceDurations.length !== concatenateSequences.length) {
    throw new Error(`Number of sequences to concatenate and their individual
 durations does not match.`);
  }

  if (isQuantizedSequence(concatenateSequences[0])) {
    // Check that all the sequences are quantized, and that their quantization
    // info matches.
    for (let i = 0; i < concatenateSequences.length; ++i) {
      assertIsQuantizedSequence(concatenateSequences[i]);
      if (concatenateSequences[i].quantizationInfo.stepsPerQuarter !==
          concatenateSequences[0].quantizationInfo.stepsPerQuarter) {
        throw new Error('Not all sequences have the same quantizationInfo');
      }
    }
    return concatenateHelper(
        concatenateSequences, 'totalQuantizedSteps', 'quantizedStartStep',
        'quantizedEndStep', sequenceDurations);
  } else {
    return concatenateHelper(
        concatenateSequences, 'totalTime', 'startTime', 'endTime',
        sequenceDurations);
  }
}

/**
 * Trim notes from a NoteSequence to lie within a specified time range.
 * Notes starting before `start` are not included. Notes ending after
 * `end` are not included, unless `truncateEndNotes` is true.
 * @param ns The NoteSequence for which to trim notes.
 * @param start The time after which all notes should begin. This should be
 * either seconds (if ns is unquantized), or a quantized step (if ns is
 * quantized).
 * @param end The time before which all notes should end. This should be
 * either seconds (if ns is unquantized), or a quantized step (if ns is
 * quantized).
 * @param truncateEndNotes Optional. If true, then notes starting before
 * the end time but ending after it will be included and truncated.
 * @returns A new NoteSequence with all notes trimmed to lie between `start`
 * and `end`, and time-shifted to begin at 0.
 */
export function trim(
    ns: INoteSequence, start: number, end: number, truncateEndNotes?: boolean) {
  return isQuantizedSequence(ns) ?
      trimHelper(
          ns, start, end, 'totalQuantizedSteps', 'quantizedStartStep',
          'quantizedEndStep', truncateEndNotes) :
      trimHelper(
          ns, start, end, 'totalTime', 'startTime', 'endTime',
          truncateEndNotes);
}

function concatenateHelper(
    seqs: INoteSequence[], totalKey: 'totalQuantizedSteps'|'totalTime',
    startKey: 'startTime'|'quantizedStartStep',
    endKey: 'endTime'|'quantizedEndStep',
    sequenceDurations?: number[]): NoteSequence {
  let concatSeq: NoteSequence;
  let totalDuration = 0;

  for (let i = 0; i < seqs.length; ++i) {
    const seqDuration =
        sequenceDurations ? sequenceDurations[i] : seqs[i][totalKey];
    if (seqDuration === 0) {
      throw Error(`Sequence ${seqs[i].id} has no ${
          totalKey}, and no individual duration was provided.`);
    }

    if (i === 0) {
      concatSeq = clone(seqs[0]);
    } else {
      Array.prototype.push.apply(concatSeq.notes, seqs[i].notes.map(n => {
        const newN: NoteSequence.INote = NoteSequence.Note.create(n);
        newN[startKey] += totalDuration;
        newN[endKey] += totalDuration;
        return newN;
      }));
    }

    totalDuration += seqDuration;
  }

  concatSeq[totalKey] = totalDuration;
  return concatSeq;
}

function trimHelper(
    ns: INoteSequence, start: number, end: number,
    totalKey: 'totalQuantizedSteps'|'totalTime',
    startKey: 'startTime'|'quantizedStartStep',
    endKey: 'endTime'|'quantizedEndStep', truncateEndNotes?: boolean) {
  const result = clone(ns);
  result[totalKey] = end;
  result.notes = result.notes.filter(
      n => n[startKey] >= start && n[startKey] <= end &&
          (truncateEndNotes || n[endKey] <= end));

  // Shift the sequence to start at 0.
  result[totalKey] -= start;
  for (let i = 0; i < result.notes.length; i++) {
    result.notes[i][startKey] -= start;
    result.notes[i][endKey] -= start;

    if (truncateEndNotes) {
      result.notes[i][endKey] = Math.min(result.notes[i][endKey],
                                         result[totalKey]);
    }
  }
  return result;
}

/**
 * Splits a quantized `NoteSequence` into smaller `NoteSequences` of
 * equal chunks. If a note splits across a chunk boundary, then it will be
 * split between the two chunks.
 *
 * Silent padding may be added to the final chunk to make it `chunkSize`.
 *
 * @param ns The `NoteSequence` to split.
 * @param chunkSize The number of steps per chunk. For example, if you want to
 * split the sequence into 2 bar chunks, then if the sequence has 4
 * steps/quarter, that will be 32 steps for each 2 bars (so a chunkSize of 32).
 *
 * @returns An array of `NoteSequences` each of which are at most `chunkSize`
 * steps.
 */
export function split(seq: INoteSequence, chunkSize: number): NoteSequence[] {
  assertIsQuantizedSequence(seq);

  // Make a clone so that we don't destroy the input.
  const ns = clone(seq);

  // Sort notes first.
  const notesBystartStep =
      ns.notes.sort((a, b) => a.quantizedStartStep - b.quantizedStartStep);

  const chunks = [];
  let startStep = 0;
  let currentNotes = [];

  for (let i = 0; i < notesBystartStep.length; i++) {
    const note = notesBystartStep[i];

    const originalStartStep = note.quantizedStartStep;
    const originalEndStep = note.quantizedEndStep;

    // Rebase this note on the current chunk.
    note.quantizedStartStep -= startStep;
    note.quantizedEndStep -= startStep;

    if (note.quantizedStartStep < 0) {
      continue;
    }
    // If this note fits in the chunk, add it to the current sequence.
    if (note.quantizedEndStep <= chunkSize) {
      currentNotes.push(note);
    } else {
      // If this note spills over, truncate it and add it to this sequence.
      if (note.quantizedStartStep < chunkSize) {
        const newNote = NoteSequence.Note.create(note);
        newNote.quantizedEndStep = chunkSize;
        // Clear any absolute times since they're not valid.
        newNote.startTime = newNote.endTime = undefined;
        currentNotes.push(newNote);

        // Keep the rest of this note, and make sure that next loop still deals
        // with it, and reset it for the next loop.
        note.quantizedStartStep = startStep + chunkSize;
        note.quantizedEndStep = originalEndStep;
      } else {
        // We didn't truncate this note at all, so reset it for the next loop.
        note.quantizedStartStep = originalStartStep;
        note.quantizedEndStep = originalEndStep;
      }

      // Do we need to look at this note again?
      if (note.quantizedEndStep > chunkSize ||
          note.quantizedStartStep > chunkSize) {
        i = i - 1;
      }
      // Save this chunk if it isn't empty.
      if (currentNotes.length !== 0) {
        const newSequence = clone(ns);
        newSequence.notes = currentNotes;
        newSequence.totalQuantizedSteps = chunkSize;
        chunks.push(newSequence);
      }

      // Start a new chunk.
      currentNotes = [];
      startStep += chunkSize;
    }
  }

  // Deal with the leftover notes we have in the last chunk.
  if (currentNotes.length !== 0) {
    const newSequence = clone(ns);
    newSequence.notes = currentNotes;
    newSequence.totalQuantizedSteps = chunkSize;
    chunks.push(newSequence);
  }
  return chunks;
}
