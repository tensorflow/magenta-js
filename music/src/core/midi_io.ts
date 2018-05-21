/**
 * A module for converting between MIDI files and our `NoteSequence` protobuf
 * representation.
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
import * as midiconvert from 'midiconvert';
import {isNullOrUndefined} from 'util';

import {INoteSequence, NoteSequence} from '../protobuf/index';

import * as constants from './constants';

export class MidiConversionError extends Error {
  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function midiToSequenceProto(midi: string): NoteSequence {
  const parsedMidi = midiconvert.parse(midi);
  const ns = NoteSequence.create();

  ns.ticksPerQuarter = parsedMidi.header.PPQ;
  ns.sourceInfo = NoteSequence.SourceInfo.create({
    parser: NoteSequence.SourceInfo.Parser.TONEJS_MIDI_CONVERT,
    encodingType: NoteSequence.SourceInfo.EncodingType.MIDI
  });

  // TODO(fjord): When MidiConvert supports multiple time signatures, update
  // accordingly.
  if (parsedMidi.header.timeSignature) {
    ns.timeSignatures.push(NoteSequence.TimeSignature.create({
      time: 0,
      numerator: parsedMidi.header.timeSignature[0],
      denominator: parsedMidi.header.timeSignature[1],
    }));
  } else {
    // Assume a default time signature of 4/4.
    ns.timeSignatures.push(NoteSequence.TimeSignature.create({
      time: 0,
      numerator: 4,
      denominator: 4,
    }));
  }

  // TODO(fjord): Add key signatures when MidiConvert supports them.

  // TODO(fjord): When MidiConvert supports multiple tempos, update
  // accordingly.
  ns.tempos.push(
      NoteSequence.Tempo.create({time: 0, qpm: parsedMidi.header.bpm}));

  // We want a unique instrument number for each combination of track and
  // program number.
  let instrumentNumber = -1;
  for (const track of parsedMidi.tracks) {
    // TODO(fjord): support changing programs within a track when
    // MidiConvert does. When that happens, we'll need a map to keep track
    // of which program number within a track corresponds to what instrument
    // number, similar to how pretty_midi works.
    if (track.notes.length > 0) {
      instrumentNumber += 1;
    }

    for (const note of track.notes) {
      const startTime: number = note.time;
      const duration: number = note.duration;
      const endTime: number = startTime + duration;

      ns.notes.push(NoteSequence.Note.create({
        instrument: instrumentNumber,
        program: track.instrumentNumber,
        startTime,
        endTime,
        pitch: note.midi,
        velocity: Math.floor(note.velocity * constants.MIDI_VELOCITIES),
        isDrum: track.isPercussion
      }));

      if (endTime > ns.totalTime) {
        ns.totalTime = endTime;
      }
    }
  }

  return ns;
}

export function sequenceProtoToMidi(ns: INoteSequence) {
  if (!ns.tempos || ns.tempos.length === 0) {
    ns.tempos = [{time: 0, qpm: constants.DEFAULT_QUARTERS_PER_MINUTE}];
  }
  if (!ns.timeSignatures || ns.timeSignatures.length === 0) {
    ns.timeSignatures = [{time: 0, numerator: 4, denominator: 4}];
  }

  if (ns.tempos.length !== 1 || ns.tempos[0].time !== 0) {
    throw new MidiConversionError(
        'NoteSequence must have exactly 1 tempo at time 0');
  }
  if (ns.timeSignatures.length !== 1 || ns.timeSignatures[0].time !== 0) {
    throw new MidiConversionError(
        'NoteSequence must have exactly 1 time signature at time 0');
  }
  const json = {
    header: {
      bpm: ns.tempos[0].qpm,
      PPQ: ns.ticksPerQuarter ? ns.ticksPerQuarter :
                                constants.DEFAULT_TICKS_PER_QUARTER,
      timeSignature:
          [ns.timeSignatures[0].numerator, ns.timeSignatures[0].denominator]
    },
    tracks: [] as Array<{}>
  };

  const tracks = new Map<number, NoteSequence.INote[]>();
  for (const note of ns.notes) {
    const instrument = note.instrument ? note.instrument : 0;
    if (!tracks.has(instrument)) {
      tracks.set(instrument, []);
    }
    tracks.get(instrument).push(note);
  }
  const instruments = Array.from(tracks.keys()).sort();
  for (let i = 0; i < instruments.length; i++) {
    if (i !== instruments[i]) {
      throw new MidiConversionError(
          'Instrument list must be continuous and start at 0');
    }

    const notes = tracks.get(i);
    const track = {
      id: i,
      notes: [] as Array<{}>,
      isPercussion: isNullOrUndefined(notes[0].isDrum) ? false :
                                                         notes[0].isDrum,
      channelNumber: notes[0].isDrum ? constants.DRUM_CHANNEL :
                                       constants.DEFAULT_CHANNEL,
      instrumentNumber: isNullOrUndefined(notes[0].program) ?
          constants.DEFAULT_PROGRAM :
          notes[0].program
    };

    track.notes = notes.map(note => {
      const velocity = isNullOrUndefined(note.velocity) ?
          constants.DEFAULT_VELOCITY :
          note.velocity;
      return {
        midi: note.pitch,
        time: note.startTime,
        duration: note.endTime - note.startTime,
        velocity: (velocity as number + 1) / constants.MIDI_VELOCITIES
      };
    });

    json['tracks'].push(track);
  }

  return midiconvert.fromJSON(json).toArray();
}
