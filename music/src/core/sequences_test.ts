/**
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

import * as test from 'tape';
import {NoteSequence} from '../protobuf/index';
import * as sequences from './sequences';

const STEPS_PER_QUARTER = 4;

function createTestNS() {
  const ns = NoteSequence.create();

  ns.tempos.push(NoteSequence.Tempo.create({qpm: 60, time: 0}));

  ns.timeSignatures.push(NoteSequence.TimeSignature.create({
    time: 0,
    numerator: 4,
    denominator: 4,
  }));

  return ns;
}

function addTrackToSequence(
    ns: NoteSequence, instrument: number, notes: number[][]) {
  for (const noteParams of notes) {
    const note = new NoteSequence.Note({
      pitch: noteParams[0],
      instrument,
      velocity: noteParams[1],
      startTime: noteParams[2],
      endTime: noteParams[3]
    });
    ns.notes.push(note);
    if (ns.totalTime < note.endTime) {
      ns.totalTime = note.endTime;
    }
  }
}

function addQuantizedTrackToSequence(
    ns: NoteSequence, instrument: number, notes: number[][]) {
  for (const noteParams of notes) {
    const note = new NoteSequence.Note({
      pitch: noteParams[0],
      instrument,
      velocity: noteParams[1],
      quantizedStartStep: noteParams[2],
      quantizedEndStep: noteParams[3]
    });
    ns.notes.push(note);
    if (ns.totalQuantizedSteps < note.quantizedEndStep) {
      ns.totalQuantizedSteps = note.quantizedEndStep;
    }
  }
}

function addChordsToSequence(
    ns: NoteSequence, chords: Array<Array<number|string>>) {
  for (const chordParams of chords) {
    const ta = NoteSequence.TextAnnotation.create({
      text: chordParams[0] as string,
      time: chordParams[1] as number,
      annotationType:
          NoteSequence.TextAnnotation.TextAnnotationType.CHORD_SYMBOL
    });
    ns.textAnnotations.push(ta);
  }
}

function addControlChangesToSequence(
    ns: NoteSequence, instrument: number, controlChanges: number[][]) {
  for (const ccParams of controlChanges) {
    const cc = NoteSequence.ControlChange.create({
      time: ccParams[0],
      controlNumber: ccParams[1],
      controlValue: ccParams[2],
      instrument
    });
    ns.controlChanges.push(cc);
  }
}

function addQuantizedStepsToSequence(
    ns: NoteSequence, quantizedSteps: number[][]) {
  quantizedSteps.forEach((qstep, i) => {
    const note = ns.notes[i];
    note.quantizedStartStep = qstep[0];
    note.quantizedEndStep = qstep[1];
    if (note.quantizedEndStep > ns.totalQuantizedSteps) {
      ns.totalQuantizedSteps = note.quantizedEndStep;
    }
  });
}

function addQuantizedChordStepsToSequence(
    ns: NoteSequence, quantizedSteps: number[]) {
  const chordAnnotations = ns.textAnnotations.filter(
      ta => ta.annotationType ===
          NoteSequence.TextAnnotation.TextAnnotationType.CHORD_SYMBOL);

  quantizedSteps.forEach((qstep, i) => {
    const ta = chordAnnotations[i];
    ta.quantizedStep = qstep;
  });
}

function addQuantizedControlStepsToSequence(
    ns: NoteSequence, quantizedSteps: number[]) {
  quantizedSteps.forEach((qstep, i) => {
    const cc = ns.controlChanges[i];
    cc.quantizedStep = qstep;
  });
}

function compareNotes(note1: NoteSequence.INote, note2: NoteSequence.INote) {
  return note1.pitch === note2.pitch && note1.velocity === note2.velocity &&
      note1.quantizedStartStep === note2.quantizedStartStep &&
      note1.quantizedEndStep === note2.quantizedEndStep;
}

function compareNotesArray(a: NoteSequence.INote[], b: NoteSequence.INote[]) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (!compareNotes(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

test('Quantize NoteSequence', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);
  addChordsToSequence(ns, [['B7', 0.22], ['Em9', 4.0]]);
  addControlChangesToSequence(ns, 0, [[2.0, 64, 127], [4.0, 64, 0]]);

  // Make a copy.
  const expectedQuantizedSequence = sequences.clone(ns);
  expectedQuantizedSequence.quantizationInfo =
      NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});
  expectedQuantizedSequence.quantizationInfo.stepsPerQuarter =
      STEPS_PER_QUARTER;
  addQuantizedStepsToSequence(
      expectedQuantizedSequence,
      [[0, 40], [1, 2], [10, 14], [16, 17], [19, 20]]);
  addQuantizedChordStepsToSequence(expectedQuantizedSequence, [1, 16]);
  addQuantizedControlStepsToSequence(expectedQuantizedSequence, [8, 16]);

  const qns = sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  t.deepEqual(
      NoteSequence.toObject(qns),
      NoteSequence.toObject(expectedQuantizedSequence));

  t.end();
});

test('Quantize NoteSequence, Time Signature Change', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);
  ns.timeSignatures.length = 0;

  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Single time signature.
  ns.timeSignatures.push(NoteSequence.TimeSignature.create(
      {numerator: 4, denominator: 4, time: 0}));
  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Multiple time signatures with no change.
  ns.timeSignatures.push(NoteSequence.TimeSignature.create(
      {numerator: 4, denominator: 4, time: 1}));
  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Time signature change.
  ns.timeSignatures.push(NoteSequence.TimeSignature.create(
      {numerator: 2, denominator: 4, time: 2}));
  t.throws(
      () => sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER),
      sequences.MultipleTimeSignatureException);

  t.end();
});

test(
    'Quantize NoteSequence, Implicit Time Signature Change', (t: test.Test) => {
      const ns = createTestNS();

      addTrackToSequence(ns, 0, [
        [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
        [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
      ]);
      ns.timeSignatures.length = 0;

      // No time signature.
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

      // Implicit time signature change.
      ns.timeSignatures.push(NoteSequence.TimeSignature.create(
          {numerator: 2, denominator: 4, time: 2}));
      t.throws(
          () => sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER),
          sequences.MultipleTimeSignatureException);

      t.end();
    });

test(
    'Quantize NoteSequence, No Implicit Time Signature Change, Out Of Order',
    (t: test.Test) => {
      const ns = createTestNS();

      addTrackToSequence(ns, 0, [
        [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
        [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
      ]);
      ns.timeSignatures.length = 0;

      // No time signature.
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

      // No implicit time signature change, but time signatures are added out of
      // order.
      ns.timeSignatures.push(NoteSequence.TimeSignature.create(
          {numerator: 2, denominator: 4, time: 2}));
      ns.timeSignatures.push(NoteSequence.TimeSignature.create(
          {numerator: 2, denominator: 4, time: 0}));
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);
      t.pass();

      t.end();
    });

test('StepsPerQuarterToStepsPerSecond', (t: test.Test) => {
  t.equal(sequences.stepsPerQuarterToStepsPerSecond(4, 60.0), 4.0);

  t.end();
});

test('QuantizeToStep', (t: test.Test) => {
  t.equal(sequences.quantizeToStep(8.0001, 4), 32);
  t.equal(sequences.quantizeToStep(8.4999, 4), 34);
  t.equal(sequences.quantizeToStep(8.4999, 4, 1.0), 33);
  t.end();
});

test('Quantize NoteSequence, Tempo Change', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);
  ns.tempos.length = 0;

  // No tempos.
  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Single tempo.
  ns.tempos.push(NoteSequence.Tempo.create({qpm: 60, time: 0}));
  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Multiple tempos with no change.
  ns.tempos.push(NoteSequence.Tempo.create({qpm: 60, time: 1}));
  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Tempo change.
  ns.tempos.push(NoteSequence.Tempo.create({qpm: 120, time: 2}));
  t.throws(
      () => sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER),
      sequences.MultipleTempoException);

  t.end();
});

test('Quantize NoteSequence, Implicit Tempo Change', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);
  ns.tempos.length = 0;

  // No tempos.
  sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  // Implicit tempo change.
  ns.tempos.push(NoteSequence.Tempo.create({qpm: 60, time: 2}));
  t.throws(
      () => sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER),
      sequences.MultipleTempoException);

  t.end();
});

test(
    'Quantize NoteSequence, No Implicit Tempo Change, Out of Order',
    (t: test.Test) => {
      const ns = createTestNS();

      addTrackToSequence(ns, 0, [
        [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
        [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
      ]);
      ns.tempos.length = 0;

      // No tempos.
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

      // No implicit tempo change, but tempos are added out of order.
      ns.tempos.push(NoteSequence.Tempo.create({qpm: 60, time: 2}));
      ns.tempos.push(NoteSequence.Tempo.create({qpm: 60, time: 0}));
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);
      t.pass();

      t.end();
    });

test('Quantize NoteSequence, Rounding', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 1, [
    [12, 100, 0.01, 0.24], [11, 100, 0.22, 0.55], [40, 100, 0.50, 0.75],
    [41, 100, 0.689, 1.18], [44, 100, 1.19, 1.69], [55, 100, 4.0, 4.01]
  ]);

  // Make a copy.
  const expectedQuantizedSequence = sequences.clone(ns);
  expectedQuantizedSequence.quantizationInfo =
      NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});

  addQuantizedStepsToSequence(
      expectedQuantizedSequence,
      [[0, 1], [1, 2], [2, 3], [3, 5], [5, 7], [16, 17]]);

  const quantizedSequence =
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  t.deepEqual(
      NoteSequence.toObject(quantizedSequence),
      NoteSequence.toObject(expectedQuantizedSequence));

  t.end();
});

test('Quantize NoteSequence, MultiTrack', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [[12, 100, 1.0, 4.0], [19, 100, 0.95, 3.0]]);
  addTrackToSequence(ns, 3, [[12, 100, 1.0, 4.0], [19, 100, 2.0, 5.0]]);
  addTrackToSequence(
      ns, 7, [[12, 100, 1.0, 5.0], [19, 100, 2.0, 4.0], [24, 100, 3.0, 3.5]]);

  // Make a copy.
  const expectedQuantizedSequence = sequences.clone(ns);
  expectedQuantizedSequence.quantizationInfo =
      NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});

  addQuantizedStepsToSequence(
      expectedQuantizedSequence,
      [[4, 16], [4, 12], [4, 16], [8, 20], [4, 20], [8, 16], [12, 14]]);

  const quantizedSequence =
      sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);

  t.deepEqual(
      NoteSequence.toObject(quantizedSequence),
      NoteSequence.toObject(expectedQuantizedSequence));

  t.end();
});

test('Assert isQuantizedNoteSequence', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);

  t.throws(
      () => sequences.assertIsQuantizedSequence(ns),
      sequences.QuantizationStatusException);

  const qns = sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);
  sequences.assertIsQuantizedSequence(qns);

  t.end();
});

test('Assert isRelativeQuantizedNoteSequence', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);

  t.throws(
      () => sequences.assertIsRelativeQuantizedSequence(ns),
      sequences.QuantizationStatusException);

  const qns = sequences.quantizeNoteSequence(ns, STEPS_PER_QUARTER);
  sequences.assertIsRelativeQuantizedSequence(qns);

  t.end();
});

function testUnQuantize(
    t: test.Test, expectedTimes: Array<[number, number]>,
    expectedTotalTime: number, originalQpm?: number, finalQpm?: number,
    originalTotalSteps?: number) {
  let qns = createTestNS();

  const notes = [
    [12, 100, 0.01, 0.24], [11, 100, 0.22, 0.55], [40, 100, 0.50, 0.75],
    [41, 100, 0.689, 1.18], [44, 100, 1.19, 1.69]
  ];
  addTrackToSequence(qns, 1, notes);
  qns = sequences.quantizeNoteSequence(qns, STEPS_PER_QUARTER);
  if (!originalQpm) {
    qns.tempos = [];
  } else {
    qns.tempos[0].qpm = originalQpm;
  }
  if (originalTotalSteps) {
    qns.totalQuantizedSteps = originalTotalSteps;
  }

  const ns = sequences.unquantizeSequence(qns, finalQpm);

  const expectedSequence = NoteSequence.create();
  expectedSequence.timeSignatures = ns.timeSignatures;
  qns.notes.forEach((n, i) => {
    expectedSequence.notes.push({
      pitch: n.pitch,
      instrument: n.instrument,
      velocity: n.velocity,
      startTime: expectedTimes[i][0],
      endTime: expectedTimes[i][1]
    });
  });
  expectedSequence.totalTime = expectedTotalTime;

  if (!finalQpm && !originalQpm) {
    expectedSequence.tempos = [];
  } else {
    expectedSequence.tempos =
        [{time: 0, qpm: finalQpm ? finalQpm : originalQpm}];
  }

  t.deepEqual(
      NoteSequence.toObject(ns), NoteSequence.toObject(expectedSequence));

  t.end();
}

test('Un-Quantize NoteSequence, ns qpm', (t: test.Test) => {
  testUnQuantize(
      t, [[0.0, 0.25], [0.25, 0.50], [0.50, 0.75], [0.75, 1.25], [1.25, 1.75]],
      1.75, 60);
});

test('Un-Quantize NoteSequence, no qpm', (t: test.Test) => {
  testUnQuantize(
      t,
      [
        [0.0, 0.125], [0.125, 0.25], [0.25, 0.375], [0.375, 0.625],
        [0.625, 0.875]
      ],
      0.875);
});

test('Un-Quantize NoteSequence, arg qpm', (t: test.Test) => {
  testUnQuantize(
      t, [[0.0, 0.5], [0.5, 1.00], [1.00, 1.5], [1.5, 2.5], [2.5, 3.5]], 3.5,
      undefined, 30);
});

test('Un-Quantize NoteSequence, orig and arg qpm', (t: test.Test) => {
  testUnQuantize(
      t, [[0.0, 0.5], [0.5, 1.00], [1.00, 1.5], [1.5, 2.5], [2.5, 3.5]], 3.5,
      60, 30);
});

test('Un-Quantize NoteSequence, existing total steps lower', (t: test.Test) => {
  testUnQuantize(
      t, [[0.0, 0.5], [0.5, 1.00], [1.00, 1.5], [1.5, 2.5], [2.5, 3.5]], 3.5,
      undefined, 30, 1);
});

test(
    'Un-Quantize NoteSequence, existing total steps higher', (t: test.Test) => {
      testUnQuantize(
          t, [[0.0, 0.5], [0.5, 1.00], [1.00, 1.5], [1.5, 2.5], [2.5, 3.5]], 10,
          undefined, 30, 20);
    });

test('Merge Instruments', (t: test.Test) => {
  const ns = createTestNS();
  ns.notes.push({pitch: 60, program: 0, isDrum: false});
  ns.notes.push({pitch: 64, program: 0, isDrum: false});
  ns.notes.push({pitch: 36, program: 0, isDrum: true});
  ns.notes.push({pitch: 48, program: 32, isDrum: false});
  ns.notes.push({pitch: 42, program: 1, isDrum: true});

  const expected = sequences.clone(ns);
  expected.notes[0].instrument = 0;
  expected.notes[1].instrument = 0;
  expected.notes[2].instrument = 2;
  expected.notes[3].instrument = 1;
  expected.notes[4].instrument = 2;
  expected.notes[4].program = 0;

  t.deepEqual(
      NoteSequence.toObject(sequences.mergeInstruments(ns)),
      NoteSequence.toObject(expected));

  t.end();
});

test('Replace Instruments', (t: test.Test) => {
  const ns1 = createTestNS();
  // This should be kept.
  ns1.notes.push({pitch: 72, instrument: 2});
  // These should be replaced.
  ns1.notes.push({pitch: 60, instrument: 0});
  ns1.notes.push({pitch: 70, instrument: 1});
  ns1.notes.push({pitch: 62, instrument: 0});
  // This should be kept.
  ns1.notes.push({pitch: 70, instrument: 2});

  const ns2 = createTestNS();
  // These should be replaced.
  ns2.notes.push({pitch: 40, instrument: 0});
  ns2.notes.push({pitch: 41, instrument: 0});
  ns2.notes.push({pitch: 42, instrument: 0});
  ns2.notes.push({pitch: 50, instrument: 1});
  ns2.notes.push({pitch: 51, instrument: 1});
  // This should not be replaced.
  ns2.notes.push({pitch: 60, instrument: 3});

  const expected = createTestNS();
  // These are sorted by instrument, then time.
  expected.notes.push({pitch: 40, instrument: 0});
  expected.notes.push({pitch: 41, instrument: 0});
  expected.notes.push({pitch: 42, instrument: 0});
  expected.notes.push({pitch: 50, instrument: 1});
  expected.notes.push({pitch: 51, instrument: 1});
  // We are not sorting by pitch.
  expected.notes.push({pitch: 72, instrument: 2});
  expected.notes.push({pitch: 70, instrument: 2});

  t.deepEqual(
      NoteSequence.toObject(sequences.replaceInstruments(ns1, ns2)),
      NoteSequence.toObject(expected));
  t.end();
});

test('Concatenate 1 NoteSequence (unquantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const expected = createTestNS();

  addTrackToSequence(ns1, 0, [[60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5]]);
  addTrackToSequence(expected, 0, [[60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5]]);

  t.deepEqual(
      NoteSequence.toObject(sequences.concatenate([ns1])),
      NoteSequence.toObject(expected));
  t.end();
});

test('Concatenate 2 NoteSequences (unquantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const ns2 = createTestNS();
  const expected = createTestNS();

  addTrackToSequence(ns1, 0, [[60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5]]);
  addTrackToSequence(ns2, 0, [[59, 100, 0.0, 1.0], [71, 100, 0.5, 1.5]]);

  addTrackToSequence(expected, 0, [
    [60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5], [59, 100, 1.5, 2.5],
    [71, 100, 2.0, 3.0]
  ]);

  t.deepEqual(
      NoteSequence.toObject(sequences.concatenate([ns1, ns2])),
      NoteSequence.toObject(expected));
  t.end();
});

test(
    'Concatenate 2 NoteSequences with individual durations (unquantized)',
    (t: test.Test) => {
      const ns1 = createTestNS();
      const ns2 = createTestNS();
      const expected = createTestNS();

      addTrackToSequence(ns1, 0, [[60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5]]);
      addTrackToSequence(ns2, 0, [[59, 100, 0.0, 1.0], [71, 100, 0.5, 1.5]]);

      addTrackToSequence(expected, 0, [
        [60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5], [59, 100, 3.0, 4.0],
        [71, 100, 3.5, 4.5]
      ]);
      expected.totalTime = 6;

      t.deepEqual(
          NoteSequence.toObject(sequences.concatenate([ns1, ns2], [3, 3])),
          NoteSequence.toObject(expected));
      t.end();
    });

test('Concatenate 3 NoteSequences (unquantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const ns2 = createTestNS();
  const ns3 = createTestNS();

  const expected = createTestNS();

  addTrackToSequence(ns1, 0, [[60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5]]);
  addTrackToSequence(ns2, 0, [[59, 100, 0.0, 1.0], [71, 100, 0.5, 1.5]]);
  addTrackToSequence(ns3, 0, [[58, 100, 1.0, 1.5], [70, 100, 2.0, 2.5]]);

  addTrackToSequence(expected, 0, [
    [60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5], [59, 100, 1.5, 2.5],
    [71, 100, 2.0, 3.0], [58, 100, 4.0, 4.5], [70, 100, 5.0, 5.5]
  ]);

  t.deepEqual(
      NoteSequence.toObject(sequences.concatenate([ns1, ns2, ns3])),
      NoteSequence.toObject(expected));
  t.end();
});

test('Concatenate 1 NoteSequence (quantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const expected = createTestNS();

  addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 2], [72, 100, 2, 3]]);
  addQuantizedTrackToSequence(expected, 0, [[60, 100, 0, 2], [72, 100, 2, 3]]);
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});

  t.deepEqual(
      NoteSequence.toObject(sequences.concatenate([ns1])),
      NoteSequence.toObject(expected));
  t.end();
});

test('Concatenate 2 NoteSequences (quantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const ns2 = createTestNS();
  const expected = createTestNS();

  addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 4], [72, 100, 2, 6]]);
  addQuantizedTrackToSequence(ns2, 0, [[59, 100, 0, 4], [71, 100, 1, 6]]);
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  ns2.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});

  addQuantizedTrackToSequence(
      expected, 0,
      [[60, 100, 0, 4], [72, 100, 2, 6], [59, 100, 6, 10], [71, 100, 7, 12]]);
  expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  t.deepEqual(
      NoteSequence.toObject(sequences.concatenate([ns1, ns2])),
      NoteSequence.toObject(expected));
  t.end();
});

test(
    'Concatenate 2 NoteSequences with individual durations (quantized)',
    (t: test.Test) => {
      const ns1 = createTestNS();
      const ns2 = createTestNS();
      const expected = createTestNS();

      addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 4], [72, 100, 2, 6]]);
      addQuantizedTrackToSequence(ns2, 0, [[59, 100, 0, 4], [71, 100, 1, 6]]);
      ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});
      ns2.quantizationInfo = NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});

      addQuantizedTrackToSequence(expected, 0, [
        [60, 100, 0, 4], [72, 100, 2, 6], [59, 100, 10, 14], [71, 100, 11, 16]
      ]);
      expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});
      expected.totalQuantizedSteps = 20;

      t.deepEqual(
          NoteSequence.toObject(sequences.concatenate([ns1, ns2], [10, 10])),
          NoteSequence.toObject(expected));
      t.end();
    });

test('Concatenate 3 NoteSequences (quantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const ns2 = createTestNS();
  const ns3 = createTestNS();

  const expected = createTestNS();

  addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 2], [72, 100, 1, 3]]);
  addQuantizedTrackToSequence(ns2, 0, [[59, 100, 0, 2], [71, 100, 1, 3]]);
  addQuantizedTrackToSequence(ns3, 0, [[58, 100, 2, 3], [70, 100, 4, 6]]);
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  ns2.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  ns3.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});

  addQuantizedTrackToSequence(expected, 0, [
    [60, 100, 0, 2], [72, 100, 1, 3], [59, 100, 3, 5], [71, 100, 4, 6],
    [58, 100, 8, 9], [70, 100, 10, 12]
  ]);
  expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});

  t.deepEqual(
      NoteSequence.toObject(sequences.concatenate([ns1, ns2, ns3])),
      NoteSequence.toObject(expected));
  t.end();
});

test('Concatenate error case: mismatched quantizationInfo', (t: test.Test) => {
  const ns1 = createTestNS();
  const ns2 = createTestNS();

  addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 4], [72, 100, 2, 6]]);
  addQuantizedTrackToSequence(ns2, 0, [[59, 100, 0, 4], [71, 100, 1, 6]]);
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  ns2.quantizationInfo =
      NoteSequence.QuantizationInfo.create({stepsPerQuarter: 1});
  t.throws(() => sequences.concatenate([ns1, ns2]), Error);
  t.end();
});

test(
    'Concatenate error case: mismatched quantized and unquantized sequences',
    (t: test.Test) => {
      const ns1 = createTestNS();
      const ns2 = createTestNS();

      addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 4], [72, 100, 2, 6]]);
      addTrackToSequence(ns2, 0, [[59, 100, 0, 4], [71, 100, 1, 6]]);
      ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
          {stepsPerQuarter: STEPS_PER_QUARTER});
      t.throws(() => sequences.concatenate([ns1, ns2]), Error);
      t.end();
    });

test('Trim NoteSequence (unquantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const expected = createTestNS();

  addTrackToSequence(ns1, 0, [
    [60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5], [59, 100, 1.5, 2.5],
    [71, 100, 2.0, 3.0], [58, 100, 3.0, 4.5], [70, 100, 5.0, 5.5]
  ]);
  addTrackToSequence(expected, 0, [[59, 100, 0, 1], [71, 100, 0.5, 1.5]]);
  expected.totalTime = 2.5;

  t.deepEqual(
      NoteSequence.toObject(sequences.trim(ns1, 1.5, 4.0)),
      NoteSequence.toObject(expected));
  t.end();
});

test('Trim and truncate NoteSequence (unquantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const expected = createTestNS();

  addTrackToSequence(ns1, 0, [
    [60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5], [59, 100, 1.5, 2.5],
    [71, 100, 2.0, 3.0], [58, 100, 3.0, 4.5], [70, 100, 5.0, 5.5]
  ]);
  addTrackToSequence(
      expected, 0, [[59, 100, 0, 1], [71, 100, 0.5, 1.5], [58, 100, 1.5, 2.5]]);
  expected.totalTime = 2.5;

  t.deepEqual(
      NoteSequence.toObject(sequences.trim(ns1, 1.5, 4.0, true)),
      NoteSequence.toObject(expected));
  t.end();
});

test('Trim NoteSequence (quantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  addQuantizedTrackToSequence(
      ns1, 0,
      [[60, 100, 0, 4], [60, 100, 2, 3], [60, 100, 3, 4], [60, 100, 3, 6]]);

  const expected = createTestNS();
  expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  addQuantizedTrackToSequence(expected, 0, [[60, 100, 1, 2], [60, 100, 2, 3]]);
  expected.totalQuantizedSteps = 4;

  t.deepEqual(
      NoteSequence.toObject(sequences.trim(ns1, 1, 5)),
      NoteSequence.toObject(expected));
  t.end();
});

test('Trim and truncate NoteSequence (quantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  addQuantizedTrackToSequence(
      ns1, 0,
      [[60, 100, 0, 4], [60, 100, 2, 3], [60, 100, 3, 4], [60, 100, 3, 6]]);

  const expected = createTestNS();
  expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  addQuantizedTrackToSequence(
      expected, 0, [[60, 100, 1, 2], [60, 100, 2, 3], [60, 100, 2, 4]]);

  t.deepEqual(
      NoteSequence.toObject(sequences.trim(ns1, 1, 5, true)),
      NoteSequence.toObject(expected));
  t.end();
});

test('Split sequence in 2 steps', (t: test.Test) => {
  let ns1 = createTestNS();
  addTrackToSequence(
      ns1, 0,
      [[60, 100, 0, 3], [72, 100, 2, 4], [80, 100, 6, 9], [20, 100, 40, 42]]);
  ns1 = sequences.quantizeNoteSequence(ns1, 1);

  // The first [60, 100, 0, 3] is split in 2 sequences.
  const expected1 = [new NoteSequence.Note(
      {pitch: 60, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 2})];
  // This contains the leftover from the first note, and [72, 100, 2, 4].
  const expected2 = [
    new NoteSequence.Note(
        {pitch: 60, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 1}),
    new NoteSequence.Note(
        {pitch: 72, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 2})
  ];
  // [80, 100, 6, 9] is basically [80, 100, 0, 3], so it's split in 2 sequences
  const expected3 = [new NoteSequence.Note(
      {pitch: 80, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 2})];
  const expected4 = [new NoteSequence.Note(
      {pitch: 80, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 1})];
  const expected5 = [new NoteSequence.Note(
      {pitch: 20, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 2})];

  const split = sequences.split(ns1, 2);
  t.equal(5, split.length);

  // The objects aren't exactly equal since the returned sequences' notes
  // have more fields (instruments, drums), so loosely compare notes.
  t.is(true, compareNotesArray(split[0].notes, expected1), 'split 1 ok');
  t.is(true, compareNotesArray(split[1].notes, expected2), 'split 2 ok');
  t.is(true, compareNotesArray(split[2].notes, expected3), 'split 3 ok');
  t.is(true, compareNotesArray(split[3].notes, expected4), 'split 4 ok');
  t.is(true, compareNotesArray(split[4].notes, expected5), 'split 5 ok');
  t.end();
});

test('Split sequence in 64 steps', (t: test.Test) => {
  let ns1 = createTestNS();
  addTrackToSequence(ns1, 0, [
    [60, 100, 0, 3], [70, 100, 2, 4], [80, 100, 6, 9], [90, 100, 40, 42],
    [10, 100, 63, 68], [20, 100, 70, 74]
  ]);
  ns1 = sequences.quantizeNoteSequence(ns1, 1);

  // There are basically just 2 sequences, before or after the 64 step mark.
  const expected1 = [
    new NoteSequence.Note(
        {pitch: 60, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 3}),
    new NoteSequence.Note(
        {pitch: 70, velocity: 100, quantizedStartStep: 2, quantizedEndStep: 4}),
    new NoteSequence.Note(
        {pitch: 80, velocity: 100, quantizedStartStep: 6, quantizedEndStep: 9}),
    new NoteSequence.Note({
      pitch: 90,
      velocity: 100,
      quantizedStartStep: 40,
      quantizedEndStep: 42
    }),
    new NoteSequence.Note({
      pitch: 10,
      velocity: 100,
      quantizedStartStep: 63,
      quantizedEndStep: 64
    })
  ];
  // This contains the leftover from the first note, and [72, 100, 2, 4].
  const expected2 = [
    new NoteSequence.Note(
        {pitch: 10, velocity: 100, quantizedStartStep: 0, quantizedEndStep: 4}),
    new NoteSequence.Note(
        {pitch: 20, velocity: 100, quantizedStartStep: 6, quantizedEndStep: 10})
  ];

  const split = sequences.split(ns1, 64);
  t.equal(2, split.length);

  // The objects aren't exactly equal since the returned sequences' notes
  // have more fields (instruments, drums), so loosely compare notes.
  t.is(true, compareNotesArray(split[0].notes, expected1), 'split 1 ok');
  t.is(true, compareNotesArray(split[1].notes, expected2), 'split 2 ok');
  t.end();
});

test('Merge Consecutive Notes', (t: test.Test) => {
  const ns1 = createTestNS();
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});

  // These should be merged.
  ns1.notes.push({pitch: 60, quantizedStartStep: 1, quantizedEndStep: 2});
  ns1.notes.push({pitch: 60, quantizedStartStep: 2, quantizedEndStep: 3});
  ns1.notes.push({pitch: 60, quantizedStartStep: 3, quantizedEndStep: 4});
  ns1.notes.push({pitch: 60, quantizedStartStep: 4, quantizedEndStep: 5});
  // This shouldn't be merged because it's not consecutive.
  ns1.notes.push({pitch: 60, quantizedStartStep: 6, quantizedEndStep: 10});
  // This shouldn't be merged because it's a different pitch.
  ns1.notes.push({pitch: 70, quantizedStartStep: 10, quantizedEndStep: 11});
  // These should be merged.
  ns1.notes.push({pitch: 70, quantizedStartStep: 11, quantizedEndStep: 13});
  ns1.notes.push({pitch: 70, quantizedStartStep: 13, quantizedEndStep: 16});
  // This shouldn't be merged because it starts on the measure boundary.
  ns1.notes.push({pitch: 70, quantizedStartStep: 16, quantizedEndStep: 17});

  const expected = createTestNS();
  expected.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  // These are sorted by instrument, then time.
  expected.notes.push({pitch: 60, quantizedStartStep: 1, quantizedEndStep: 5});
  expected.notes.push({pitch: 60, quantizedStartStep: 6, quantizedEndStep: 10});
  expected.notes.push(
      {pitch: 70, quantizedStartStep: 10, quantizedEndStep: 16});
  expected.notes.push(
      {pitch: 70, quantizedStartStep: 16, quantizedEndStep: 17});

  t.deepEqual(
      NoteSequence.toObject(sequences.mergeConsecutiveNotes(ns1)),
      NoteSequence.toObject(expected));
  t.end();
});

test('applySustain error case: quantized sequence', (t: test.Test) => {
  const ns1 = createTestNS();

  addQuantizedTrackToSequence(ns1, 0, [[60, 100, 0, 4], [72, 100, 2, 6]]);
  ns1.quantizationInfo = NoteSequence.QuantizationInfo.create(
      {stepsPerQuarter: STEPS_PER_QUARTER});
  t.throws(() => sequences.applySustainControlChanges(ns1), Error);
  t.end();
});

test('applySustain to sequence without sustain', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [12, 100, 0.01, 10.0], [11, 55, 0.22, 0.50], [40, 45, 2.50, 3.50],
    [55, 120, 4.0, 4.01], [52, 99, 4.75, 5.0]
  ]);

  const sustainedNS = sequences.applySustainControlChanges(ns);

  t.deepEqual(
    NoteSequence.toObject(ns),
    NoteSequence.toObject(sustainedNS));
  t.end();
});

test('applySustain to sequence with sustain', (t: test.Test) => {
  const ns = createTestNS();

  addTrackToSequence(ns, 0, [
    [60, 100, 1.0, 2.0],
    [61, 100, 2.0, 3.0],
    [62, 100, 3.0, 4.0],
    [64, 100, 5.0, 6.0],
    [65, 100, 6.0, 7.0]
  ]);
  addControlChangesToSequence(ns, 0, [
     [0.0, 64, 127],
     [5.0, 64, 0]
  ]);

  const expectedNS = createTestNS();

  addTrackToSequence(expectedNS, 0, [
    [60, 100, 1.0, 5.0],
    [61, 100, 2.0, 5.0],
    [62, 100, 3.0, 5.0],
    [64, 100, 5.0, 6.0],
    [65, 100, 6.0, 7.0]
  ]);
  addControlChangesToSequence(expectedNS, 0, [
    [0.0, 64, 127],
    [5.0, 64, 0]
  ]);

  const sustainedNS = sequences.applySustainControlChanges(ns);

  t.deepEqual(
    NoteSequence.toObject(sustainedNS),
    NoteSequence.toObject(expectedNS));
  t.end();
});
