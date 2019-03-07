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

  const expectedSequence = sequences.clone(qns);
  expectedSequence.notes.map((n, i) => {
    n.startTime = expectedTimes[i][0];
    n.endTime = expectedTimes[i][1];
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
        [60, 100, 0, 4], [72, 100, 2, 6], [59, 100, 10, 14],
        [71, 100, 11, 16]
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

  try {
    sequences.concatenate([ns1, ns2]);
  } catch (error) {
    t.end();
  }
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

      try {
        sequences.concatenate([ns1, ns2]);
      } catch (error) {
        t.end();
      }
    });

test('Trim NoteSequence (unquantized)', (t: test.Test) => {
  const ns1 = createTestNS();
  const expected = createTestNS();

  addTrackToSequence(ns1, 0, [
    [60, 100, 0.0, 1.0], [72, 100, 0.5, 1.5], [59, 100, 1.5, 2.5],
    [71, 100, 2.0, 3.0], [58, 100, 3.0, 4.5], [70, 100, 5.0, 5.5]
  ]);
  addTrackToSequence(expected, 0, [[59, 100, 0, 1], [71, 100, 0.5, 1.5]]);
  expected.totalTime = 4;

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
      expected, 0, [[59, 100, 0, 1], [71, 100, 0.5, 1.5], [58, 100, 1.5, 3.0]]);
  expected.totalTime = 4;

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
  expected.totalQuantizedSteps = 5;

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
      expected, 0, [[60, 100, 1, 2], [60, 100, 2, 3], [60, 100, 2, 5]]);

  t.deepEqual(
      NoteSequence.toObject(sequences.trim(ns1, 1, 5, true)),
      NoteSequence.toObject(expected));
  t.end();
});
