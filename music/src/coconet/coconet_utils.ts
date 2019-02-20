
/**
 * Utility functions for the [Coconet]{@link} model.
 *
 * @license
 * Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
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
import {INoteSequence, NoteSequence} from '../protobuf';

export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
export const DURATION_STEPS = 32;
// The length of the pitch array in Pianoroll.
export const NUM_PITCHES = 46;
// The pitch array in Pianoroll is shifted so that index 0 is MIN_PITCH.
export const MIN_PITCH = 36;

/**
 * Converts a pianoroll representation to a `NoteSequence`.
 *
 * @param pianoroll Array of shape `[steps][NUM_PITCHES][4]`, where each entry
 * represents an instrument being played at a particular step and for
 * a particular pitch. For example, `pianoroll[0][64] =[0, 0, 1, 0]` means
 * that the third instrument plays pitch 64 at time 0. Note: this representation
 * can't distinguish between multiple eight notes and held notes.
 * @returns A `NoteSequence` containing the melody.
 */
export function pianorollToSequence(pianoroll: number[][][]): NoteSequence {
  const sequence = NoteSequence.create();
  const notes: NoteSequence.Note[] = [];
  pianoroll.forEach((step: number[][], stepIndex) => {
    step.forEach((pitch, pitchIndex) => {
      pitch.forEach((value: number, voiceIndex: number) => {
        if (value === 1.0) {
          const note = new NoteSequence.Note();
          note.pitch = pitchIndex + MIN_PITCH;
          note.instrument = voiceIndex;
          note.quantizedStartStep = stepIndex;
          note.quantizedEndStep = stepIndex + 1;
          notes.push(note);
        }
      });
    });
  });
  sequence.notes = notes;
  sequence.totalQuantizedSteps = notes[notes.length - 1].quantizedEndStep;
  return sequence;
}

/**
 * Converts a `NoteSequence` to a pianoroll representation.
 *
 * @param ns A `NoteSequence` containing a melody.
 * @returns An array of shape `[numberOfSteps][NUM_PITCHES][4]` where each entry
 * represents an instrument being played at a particular step and for
 * a particular pitch. For example, `pianoroll[0][64] =[0, 0, 1, 0]` means
 * that the third instrument plays pitch 64 at time 0. Note: this representation
 * can't distinguish between multiple eight notes and held notes.
 */
export function sequenceToPianoroll(
    ns: INoteSequence, numberOfSteps: number): number[][][] {
  const pianoroll = buildEmptyPianoroll(numberOfSteps);
  const notes = ns.notes;
  notes.forEach(note => {
    const pitchIndex = note.pitch - MIN_PITCH;
    const stepIndex = note.quantizedStartStep;
    const duration = note.quantizedEndStep - note.quantizedStartStep;
    const voice = note.instrument;

    if (voice < 0 || voice > 3) {
      throw new Error(`Found invalid voice ${voice}. Skipping.`);
    } else {
      for (let i = stepIndex; i < stepIndex + duration; i++) {
        pianoroll[i][pitchIndex][voice] = 1;
      }
    }
  });
  return pianoroll;
}

/**
 * Reshapes a 1D array of size `[numberOfSteps * NUM_PITCHES * 4]` into a
 * 3D pianoroll of shape `[numberOfSteps][NUM_PITCHES][4]`.
 * @param flatArray The 1D input array.
 * @param numberOfSteps The size of the first dimension, representing the number
 * of steps in the sequence.
 * @returns A reshaped array with shape `[steps][pitches][4]`.
 */
export function flatArrayToPianoroll(
    flatArray: number[], numberOfSteps: number): number[][][] {
  const pianoroll = [];
  for (let stepIndex = 0; stepIndex < numberOfSteps; stepIndex++) {
    const step = [];
    for (let pitchIndex = 0; pitchIndex < NUM_PITCHES; pitchIndex++) {
      const index = stepIndex * NUM_PITCHES * 4 + pitchIndex * 4;
      step.push(flatArray.slice(index, index + 4));
    }
    pianoroll.push(step);
  }
  return pianoroll;
}

/**
 * Creates an empty 3D pianoroll of shape `[numberOfSteps][NUM_PITCHES][4]`.
 * @param numberOfSteps The size of the first dimension, representing the number
 * of steps in the sequence.
 * @returns The initialized pianoroll.
 */
function buildEmptyPianoroll(numberOfSteps: number) {
  const pianoroll = [];
  for (let stepIndex = 0; stepIndex < numberOfSteps; stepIndex++) {
    const step = [];
    for (; step.push([0, 0, 0, 0]) < NUM_PITCHES;) {
    }
    pianoroll.push(step);
  }
  return pianoroll;
}
