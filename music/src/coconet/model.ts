/**
 * Implementation for [Coconet]{@link
 * https://ismir2017.smcnus.org/wp-content/uploads/2017/10/187_Paper.pdf%7D}
 * models.
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
 * =============================================================================
 */
import * as tf from '@tensorflow/tfjs-core';

import {fetch, performance} from '../core/compat/global';
import * as logging from '../core/logging';
import * as sequences from '../core/sequences';
import {INoteSequence} from '../protobuf/index';

import {IS_IOS, NUM_PITCHES, pianorollToSequence, sequenceToPianoroll} from './coconet_utils';

/**
 * An interface for providing an infilling mask.
 * @param step The quantized time step at which to infill.
 * @param voice The voice to infill at the time step.
 */
interface InfillMask {
  step: number;
  voice: number;
}

/**
 * An interface for providing configurable properties to a Coconet model.
 * @param temperature (Optional) The softmax temperature to use when sampling
 * from the logits. Default is 0.99.
 * @param numIterations (Optional) The number of Gibbs sampling iterations
 * before the final output. Fewer iterations will be faster but have poorer
 * results; more iterations will be slower but have better results.
 * @param infillMask (Optional) Array of timesteps at which the model should
 * infill notes. The array should contain pairs of the form
 * `{step: number, voice: number}`, indicating which voice should be
 * infilled for a particular step. If this value isn't provided, then the model
 * will attempt to infill all the "silent" steps in the input sequence.
 */
interface CoconetConfig {
  temperature?: number;
  numIterations?: number;
  infillMask?: InfillMask[];
}

interface LayerSpec {
  pooling?: number[];
  filters?: number[];
  activation?: string;
  dilation?: number[];
  activeNoteRGB?: string;
  minPitch?: number;
  maxPitch?: number;
  poolPad?: 'same'|'valid';
  convPad?: string;
  convStride?: number;
}

interface ModelSpec {
  useSoftmaxLoss: boolean;
  batchNormVarianceEpsilon: number;
  numInstruments: number;
  numFilters: number;
  numLayers: number;
  numRegularConvLayers: number;
  dilation?: number[][];
  layers: LayerSpec[];
  interleaveSplitEveryNLayers?: number;
  numPointwiseSplits?: number;
}

const DEFAULT_SPEC: ModelSpec = {
  useSoftmaxLoss: true,
  batchNormVarianceEpsilon: 1.0e-07,
  numInstruments: 4,
  numFilters: 128,
  numLayers: 33,
  numRegularConvLayers: 0,
  dilation: [
    [1, 1], [2, 2], [4, 4], [8, 8], [16, 16], [16, 32],
    [1, 1], [2, 2], [4, 4], [8, 8], [16, 16], [16, 32],
    [1, 1], [2, 2], [4, 4], [8, 8], [16, 16], [16, 32],
    [1, 1], [2, 2], [4, 4], [8, 8], [16, 16], [16, 32],
    [1, 1], [2, 2], [4, 4], [8, 8], [16, 16], [16, 32]
  ],
  layers: null,
  interleaveSplitEveryNLayers: 16,
  numPointwiseSplits: 4,
};

class ConvNet {
  private residualPeriod = 2;
  private outputForResidual: tf.Tensor = null;
  private residualCounter = -1;
  private spec: ModelSpec;

  // Save for disposal.
  private rawVars: {[varName: string]: tf.Tensor} = null;

  constructor(spec: ModelSpec, vars: {[varName: string]: tf.Tensor}) {
    this.spec = spec;
    this.rawVars = vars;
  }

  dispose() {
    if (this.rawVars !== null) {
      tf.dispose(this.rawVars);
    }
    if (this.outputForResidual) {
      this.outputForResidual.dispose();
    }
  }

  public predictFromPianoroll(pianoroll: tf.Tensor4D, masks: tf.Tensor4D):
      tf.Tensor {
    return tf.tidy(() => {
      let featuremaps = this.getConvnetInput(pianoroll, masks);

      const n = this.spec.layers.length;
      for (let i = 0; i < n; i++) {
        this.residualCounter += 1;
        this.residualSave(featuremaps);
        let numPointwiseSplits = null;
        if (this.spec.interleaveSplitEveryNLayers && i > 0 && i < n - 2 &&
            i % (this.spec.interleaveSplitEveryNLayers + 1) === 0) {
          numPointwiseSplits = this.spec.numPointwiseSplits;
        }
        featuremaps = this.applyConvolution(
            featuremaps, this.spec.layers[i], i,
            i >= this.spec.numRegularConvLayers, numPointwiseSplits);
        featuremaps = this.applyResidual(featuremaps, i === 0, i === n - 1, i);
        featuremaps = this.applyActivation(featuremaps, this.spec.layers[i], i);
        featuremaps = this.applyPooling(featuremaps, this.spec.layers[i], i);
      }
      return this.computePredictions(featuremaps);
    });
  }

  private computePredictions(logits: tf.Tensor): tf.Tensor {
    if (this.spec.useSoftmaxLoss) {
      return logits.transpose([0, 1, 3, 2]).softmax().transpose([0, 1, 3, 2]);
    }
    return logits.sigmoid();
  }

  private residualReset() {
    this.outputForResidual = null;
    this.residualCounter = 0;
  }

  private residualSave(x: tf.Tensor) {
    if (this.residualCounter % this.residualPeriod === 1) {
      this.outputForResidual = x;
    }
  }

  private applyResidual(
      x: tf.Tensor4D, isFirst: boolean, isLast: boolean,
      i: number): tf.Tensor4D {
    if (this.outputForResidual == null) {
      return x;
    }
    if (this.outputForResidual
            .shape[this.outputForResidual.shape.length - 1] !==
        x.shape[x.shape.length - 1]) {
      this.residualReset();
      return x;
    }
    if (this.residualCounter % this.residualPeriod === 0) {
      if (!isFirst && !isLast) {
        x = x.add(this.outputForResidual);
      }
    }
    return x;
  }

  private getVar(name: string, layerNum: number): tf.Tensor4D {
    const varname = `model/conv${layerNum}/${name}`;
    return this.rawVars[varname] as tf.Tensor4D;
  }

  private getSepConvVar(name: string, layerNum: number): tf.Tensor4D {
    const varname = `model/conv${layerNum}/SeparableConv2d/${name}`;
    return this.rawVars[varname] as tf.Tensor4D;
  }

  private getPointwiseSplitVar(
      name: string, layerNum: number, splitNum: number) {
    // tslint:disable-next-line:max-line-length
    const varname =
        `model/conv${layerNum}/split_${layerNum}_${splitNum}/${name}`;
    return this.rawVars[varname];
  }

  private applyConvolution(
      x: tf.Tensor4D, layer: LayerSpec, i: number, depthwise: boolean,
      numPointwiseSplits?: number): tf.Tensor4D {
    if (layer.filters == null) {
      return x;
    }
    const filterShape = layer.filters;
    const stride = layer.convStride || 1;
    const padding = layer.convPad ?
        layer.convPad.toLowerCase() as 'same' | 'valid' :
        'same';
    let conv = null;
    if (depthwise) {
      const dWeights = this.getSepConvVar('depthwise_weights', i);
      if (!numPointwiseSplits) {
        const pWeights = this.getSepConvVar('pointwise_weights', i);
        const biases = this.getSepConvVar('biases', i);
        const sepConv = tf.separableConv2d(
            x, dWeights, pWeights, [stride, stride], padding,
            (layer.dilation as [number, number]), 'NHWC');
        conv = sepConv.add(biases);
      } else {
        conv = tf.depthwiseConv2d(
            x, dWeights, [stride, stride], padding, 'NHWC',
            (layer.dilation as [number, number]));
        const splits = tf.split(conv, numPointwiseSplits, conv.rank - 1);
        const pointwiseSplits = [];
        for (let splitIdx = 0; splitIdx < numPointwiseSplits; splitIdx++) {
          const outputShape = filterShape[3] / numPointwiseSplits;
          const weights = this.getPointwiseSplitVar('kernel', i, splitIdx);
          const biases = this.getPointwiseSplitVar('bias', i, splitIdx);
          const dot = tf.matMul(
              splits[splitIdx].reshape([-1, outputShape]), weights, false,
              false);
          const bias = tf.add(dot, biases);
          pointwiseSplits.push(bias.reshape([
            splits[splitIdx].shape[0], splits[splitIdx].shape[1],
            splits[splitIdx].shape[2], outputShape
          ]));
        }
        conv = tf.concat(pointwiseSplits, conv.rank - 1);
      }
    } else {
      const weights = this.getVar('weights', i);
      const stride = layer.convStride || 1;
      const padding = layer.convPad ?
          layer.convPad.toLowerCase() as 'same' | 'valid' :
          'same';
      conv = tf.conv2d(x, weights, [stride, stride], padding, 'NHWC', [1, 1]);
    }
    return this.applyBatchnorm(conv as tf.Tensor4D, i) as tf.Tensor4D;
  }

  private applyBatchnorm(x: tf.Tensor4D, i: number): tf.Tensor {
    const gammas = this.getVar('gamma', i);
    const betas = this.getVar('beta', i);
    const mean = this.getVar('popmean', i);
    const variance = this.getVar('popvariance', i);
    if (IS_IOS) {
      // iOS WebGL floats are 16-bit, and the variance is outside this range.
      // This loads the variance to 32-bit floats in JS to compute batchnorm.
      // This arraySync is OK because we don't use the variance anywhere,
      // so it doesn't actually get uploaded to the GPU, so we don't
      // continuously download it and upload it which is the problem with
      // dataSync.
      const v = variance.arraySync()[0][0][0];
      const stdevs = tf.tensor(v.map(
          (x: number) => Math.sqrt(x + this.spec.batchNormVarianceEpsilon)));
      return x.sub(mean).mul(gammas.div(stdevs)).add(betas);
    }
    return tf.batchNorm(
        x, tf.squeeze(mean), tf.squeeze(variance), tf.squeeze(betas),
        tf.squeeze(gammas), this.spec.batchNormVarianceEpsilon);
  }

  private applyActivation(x: tf.Tensor4D, layer: LayerSpec, i: number):
      tf.Tensor4D {
    if (layer.activation === 'identity') {
      return x;
    }
    return x.relu();
  }

  private applyPooling(x: tf.Tensor4D, layer: LayerSpec, i: number):
      tf.Tensor4D {
    if (layer.pooling == null) {
      return x;
    }
    const pooling = layer.pooling;
    const padding = layer.poolPad ?
        layer.poolPad.toLowerCase() as 'same' | 'valid' :
        'same';
    return tf.maxPool(
        x, [pooling[0], pooling[1]], [pooling[0], pooling[1]], padding);
  }

  private getConvnetInput(pianoroll: tf.Tensor4D, masks: tf.Tensor4D):
      tf.Tensor4D {
    pianoroll = tf.scalar(1, 'float32').sub(masks).mul(pianoroll);
    masks = tf.scalar(1, 'float32').sub(masks);
    return pianoroll.concat(masks, 3);
  }
}

/**
 * Coconet model implementation in TensorflowJS.
 * Thanks to [James Wexler](https://github.com/jameswex) for the original
 * implementation.
 */
class Coconet {
  private checkpointURL: string;
  private spec: ModelSpec = null;
  private convnet: ConvNet;
  private initialized = false;

  /**
   * `Coconet` constructor.
   *
   * @param checkpointURL Path to the checkpoint directory.
   */
  constructor(checkpointURL: string) {
    this.checkpointURL = checkpointURL;
    this.spec = DEFAULT_SPEC;
  }

  /**
   * Loads variables from the checkpoint and instantiates the model.
   */
  async initialize() {
    this.dispose();

    const startTime = performance.now();
    this.instantiateFromSpec();
    const vars = await fetch(`${this.checkpointURL}/weights_manifest.json`)
                     .then((response) => response.json())
                     .then(
                         (manifest: tf.io.WeightsManifestConfig) =>
                             tf.io.loadWeights(manifest, this.checkpointURL));
    this.convnet = new ConvNet(this.spec, vars);
    this.initialized = true;
    logging.logWithDuration('Initialized model', startTime, 'Coconet');
  }

  dispose() {
    if (this.convnet) {
      this.convnet.dispose();
    }
    this.initialized = false;
  }

  isInitialized() {
    return this.initialized;
  }

  /**
   * Sets up layer configuration from params
   */
  instantiateFromSpec() {
    // Outermost dimensions' sizes of the non-final layers in the network.
    const nonFinalLayerFilterOuterSizes = 3;

    // Outermost dimensions' sizes of the last two layers in the network.
    const finalTwoLayersFilterOuterSizes = 2;

    this.spec.layers = [];
    // Set-up filter size of first convolutional layer.
    this.spec.layers.push({
      filters: [
        nonFinalLayerFilterOuterSizes, nonFinalLayerFilterOuterSizes,
        this.spec.numInstruments * 2, this.spec.numFilters
      ]
    });
    // Set-up filter sizes of middle convolutional layers.
    for (let i = 0; i < this.spec.numLayers - 3; i++) {
      this.spec.layers.push({
        filters: [
          nonFinalLayerFilterOuterSizes, nonFinalLayerFilterOuterSizes,
          this.spec.numFilters, this.spec.numFilters
        ],
        dilation: this.spec.dilation ? this.spec.dilation[i] : null
      });
    }
    // Set-up filter size of penultimate convolutional layer.
    this.spec.layers.push({
      filters: [
        finalTwoLayersFilterOuterSizes, finalTwoLayersFilterOuterSizes,
        this.spec.numFilters, this.spec.numFilters
      ]
    });
    // Set-up filter size and activation of final convolutional layer.
    this.spec.layers.push({
      filters: [
        finalTwoLayersFilterOuterSizes, finalTwoLayersFilterOuterSizes,
        this.spec.numFilters, this.spec.numInstruments
      ],
      activation: 'identity',
    });
  }

  /**
   * Use the model to generate a Bach-style 4-part harmony, conditioned on an
   * input sequence. The notes in the input sequence should have the
   * `instrument` property set corresponding to which voice the note belongs to:
   * 0 for Soprano, 1 for Alto, 2 for Tenor and 3 for Bass.
   *
   * **Note**: regardless of the length of the notes in the original sequence,
   * all the notes in the generated sequence will be 1 step long. If you want
   * to clean up the sequence to consider consecutive notes for the same
   * pitch and instruments as "held", you can call `mergeHeldNotes` on the
   * result. This function will replace any of the existing voices with
   * the output of the model. If you want to restore any of the original voices,
   * you can call `replaceVoice` on the output, specifying which voice should be
   * restored.
   *
   * @param sequence The sequence to infill. Must be quantized.
   * @param config (Optional) Infill parameterers like temperature, the number
   * of sampling iterations, or masks.
   */
  async infill(sequence: INoteSequence, config?: CoconetConfig) {
    sequences.assertIsRelativeQuantizedSequence(sequence);
    if (sequence.notes.length === 0) {
      throw new Error(
          `NoteSequence ${sequence.id} does not have any notes to infill.`);
    }
    const numSteps = sequence.totalQuantizedSteps ||
        sequence.notes[sequence.notes.length - 1].quantizedEndStep;

    // Convert the sequence to a pianoroll.
    const pianoroll = sequenceToPianoroll(sequence, numSteps);

    // Figure out the sampling configuration.
    let temperature = 0.99;
    let numIterations = 96;
    let outerMasks;
    if (config) {
      numIterations = config.numIterations || numIterations;
      temperature = config.temperature || temperature;
      outerMasks =
          this.getCompletionMaskFromInput(config.infillMask, pianoroll);
    } else {
      outerMasks = this.getCompletionMask(pianoroll);
    }

    // Run sampling on the pianoroll.
    const samples =
        await this.run(pianoroll, numIterations, temperature, outerMasks);

    // Convert the resulting pianoroll to a noteSequence.
    const outputSequence = pianorollToSequence(samples, numSteps);

    pianoroll.dispose();
    samples.dispose();
    outerMasks.dispose();
    return outputSequence;
  }

  /**
   * Runs sampling on pianorolls.
   */
  private async run(
      pianorolls: tf.Tensor4D, numSteps: number, temperature: number,
      outerMasks: tf.Tensor4D): Promise<tf.Tensor4D> {
    return this.gibbs(pianorolls, numSteps, temperature, outerMasks);
  }

  private getCompletionMaskFromInput(
      masks: InfillMask[], pianorolls: tf.Tensor4D): tf.Tensor4D {
    if (!masks) {
      return this.getCompletionMask(pianorolls);
    } else {
      // Create a buffer to store the input.
      const buffer = tf.buffer([pianorolls.shape[1], 4]);
      for (let i = 0; i < masks.length; i++) {
        buffer.set(1, masks[i].step, masks[i].voice);
      }
      // Expand that buffer to the right shape.
      return tf.tidy(() => {
        return buffer.toTensor()
                   .expandDims(1)
                   .tile([1, NUM_PITCHES, 1])
                   .expandDims(0) as tf.Tensor4D;
      });
    }
  }

  private getCompletionMask(pianorolls: tf.Tensor4D): tf.Tensor4D {
    return tf.tidy(() => {
      const isEmpty = pianorolls.sum(2, true).equal(tf.scalar(0, 'float32'));
      // Explicit broadcasting.
      return tf.cast(isEmpty, 'float32').add(tf.zerosLike(pianorolls));
    });
  }

  private async gibbs(
      pianorolls: tf.Tensor4D, numSteps: number, temperature: number,
      outerMasks: tf.Tensor4D): Promise<tf.Tensor4D> {
    const numStepsTensor = tf.scalar(numSteps, 'float32');
    let pianoroll = pianorolls.clone();
    for (let s = 0; s < numSteps; s++) {
      const pm = this.yaoSchedule(s, numStepsTensor);
      const innerMasks = this.bernoulliMask(pianoroll.shape, pm, outerMasks);
      await tf.nextFrame();
      const predictions = tf.tidy(() => {
        return this.convnet.predictFromPianoroll(pianoroll, innerMasks);
      }) as tf.Tensor4D;
      await tf.nextFrame();
      pianoroll = tf.tidy(() => {
        const samples =
            this.samplePredictions(predictions, temperature) as tf.Tensor4D;
        const updatedPianorolls =
            tf.where(tf.cast(innerMasks, 'bool'), samples, pianoroll);
        pianoroll.dispose();
        predictions.dispose();
        innerMasks.dispose();
        pm.dispose();
        return updatedPianorolls;
      });
      await tf.nextFrame();
    }
    numStepsTensor.dispose();
    return pianoroll;
  }

  private yaoSchedule(i: number, n: tf.Scalar) {
    return tf.tidy(() => {
      const pmin = tf.scalar(0.1, 'float32');
      const pmax = tf.scalar(0.9, 'float32');
      const alpha = tf.scalar(0.7, 'float32');
      const wat = pmax.sub(pmin).mul(tf.scalar(i, 'float32')).div(n);
      const secondArg = pmax.sub(wat).div(alpha);
      return pmin.reshape([1]).concat(secondArg.reshape([1])).max();
    });
  }

  private bernoulliMask(
      shape: number[], pm: tf.Tensor, outerMasks: tf.Tensor4D): tf.Tensor4D {
    return tf.tidy(() => {
      const [bb, tt, pp, ii] = shape;
      const probs = tf.tile(
          tf.randomUniform([bb, tt, 1, ii], 0, 1, 'float32'), [1, 1, pp, 1]);
      const masks = probs.less(pm);
      return tf.cast(masks, 'float32').mul(outerMasks);
    });
  }

  private samplePredictions(predictions: tf.Tensor4D, temperature: number):
      tf.Tensor {
    return tf.tidy(() => {
      predictions = tf.pow(predictions, tf.scalar(1 / temperature, 'float32'));
      const cmf = tf.cumsum(predictions, 2, false, false);
      const totalMasses = cmf.slice(
          [0, 0, cmf.shape[2] - 1, 0],
          [cmf.shape[0], cmf.shape[1], 1, cmf.shape[3]]);
      const u = tf.randomUniform(totalMasses.shape, 0, 1, 'float32');
      const i = u.mul(totalMasses).less(cmf).argMax(2);
      return tf.oneHot(i.flatten(), predictions.shape[2], 1, 0)
          .reshape([
            predictions.shape[0], predictions.shape[1], predictions.shape[3],
            predictions.shape[2]
          ])
          .transpose([0, 1, 3, 2])
          .cast("float32");
    });
  }
}

export {Coconet};
