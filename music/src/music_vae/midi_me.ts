/**
 * Core implementation for MidiME, a hierarchical variational autoencoder
 * that is trained on latent vectors generated by `MusicVAE`.
 *
 * @license
 * Copyright 2019 Google Inc. All Rights Reserved.
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

import * as tf from '@tensorflow/tfjs';
import * as logging from '../core/logging.js';
export {MidiMe};

/**
 * Class for sampling from a multivariate Gaussian distribution.
 */
class SamplingLayer extends tf.layers.Layer {
  constructor() {
    super({});
  }

  computeOutputShape(inputShape: tf.Shape[]) {
    return inputShape[0];
  }

  call(inputs: [tf.Tensor2D, tf.Tensor2D]) {
    return tf.tidy(() => {
      const [mu, sigma] = inputs;
      return tf.add(tf.mul(tf.randomNormal(sigma.shape), sigma), mu);
    });
  }
  getClassName() {
    return 'SamplingLayer';
  }
}

/**
 * An interface for providing configurable properties to the MidiMe model.
 * @param input_size The size of the VAE input. Since the inputs to this
 * VAE are actually latent vectors from MusicVAE, then this number should be
 * equal to the number of latent variables used by MusicVAE (`zDims`). The
 * default is 256.
 * @param latent_size The size of the model's latent vector. The default is 4.
 * @param encoder_layers The shape of the layers in the Encoder network. The
 * default is [1024, 256, 64].
 * @param decoder_layers The shape of the layers in the Decoder network. The
 * default is [64, 256, 1024].
 * @param beta Weight of the variational loss in the total VAE loss. Default
 *     is 1.
 * @param epochs Number of epochs to train for. Default is 10.
 */
interface MidiMeConfig {
  input_size?: number;
  latent_size?: number;
  encoder_layers?: number[];
  decoder_layers?: number[];
  beta?: number;
  // For training:
  epochs?: number;
}

/**
 * Main `MidiMe` model class.
 *
 * A `MidiMe` is a hierarchical variational autoencoder that is trained on
 * latent vectors generated by `MusicVAE`. It allows you to personalize your own
 * MusicVAE model with just a little data, so that samples from MidiMe sound
 * similar to the input data.
 */
class MidiMe {
  // Model configuration.
  public config: MidiMeConfig;

  // Main model and submodels.
  private vae: tf.LayersModel;
  private encoder: tf.LayersModel;
  private decoder: tf.LayersModel;

  trained = false;
  initialized = false;

  /**
   * `MidiMe` constructor.
   *
   * @param config (optional) Model configuration.
   */
  constructor(config: MidiMeConfig = {}) {
    this.config = {
      encoder_layers: config.encoder_layers || [1024, 256, 64],
      decoder_layers: config.decoder_layers || [64, 256, 1024],
      input_size: config.input_size || 256,
      latent_size: config.latent_size || 4,
      beta: config.beta || 1,
      epochs: config.epochs || 10
    };
  }

  /**
   * Disposes of any untracked tensors to avoid GPU memory leaks.
   */
  dispose() {
    if (!this.initialized) {
      return;
    }
    this.encoder.dispose();
    this.decoder.dispose();
    this.vae.dispose();
    this.initialized = false;
  }

  /**
   * Instantiates the `Encoder`, `Decoder` and the main `VAE`.
   */
  initialize() {
    this.dispose();

    const startTime = performance.now();
    const x = tf.input({shape: [this.config['input_size']]});

    // Encoder model, goes from the original input, returns an output.
    this.encoder = this.getEncoder(x);
    const [z, , ] = this.encoder.apply(x) as tf.SymbolicTensor[];

    // Decoder model, goes from the output of the encoder, to the final output.
    this.decoder = this.getDecoder(z.shape.slice(1));
    const y = this.decoder.apply(z) as tf.SymbolicTensor;

    this.vae = tf.model({inputs: x, outputs: y, name: 'vae'});

    this.initialized = true;
    logging.logWithDuration('Initialized model', startTime, 'MidiMe');
  }

  /**
   * Trains the `VAE` on the provided data. The number of epochs to train for
   * is taken from the model's configuration.
   * @param data A `Tensor` of shape `[_, this.config['latent_size']]`.
   * @param callback A function to be called at the end of every
   * training epoch, containing the training errors for that epoch.
   */
  async train(xTrain: tf.Tensor, callback?: Function) {
    const startTime = performance.now();
    this.trained = false;

    // On float16 devices, use a smaller learning rate to avoid NaNs.
    let learningRate = 0.001;  // The default tf.train.adam rate.
    if (tf.ENV.get('WEBGL_RENDER_FLOAT32_ENABLED') === false &&
        tf.ENV.get('WEBGL_DOWNLOAD_FLOAT_ENABLED') === false &&
        tf.ENV.get('WEBGL_VERSION') === 1) {
      // This is a float16 device!
      learningRate = 0.00005;
    }
    const optimizer = tf.train.adam(learningRate);

    // TODO(notwaldorf): If there's a ton of data we should consider batching.
    for (let e = 0; e < this.config.epochs; e++) {
      await tf.nextFrame();

      await optimizer.minimize(() => {
        return tf.tidy(() => {
          const [, zMu, zSigma] = this.encoder.predict(xTrain) as tf.Tensor[];
          const y = this.vae.predict(xTrain) as tf.Tensor;
          const loss = this.loss(zMu, zSigma, y, xTrain);

          if (callback) {
            callback(e, {
              y,
              total: loss.totalLoss.arraySync(),
              losses: [loss.reconLoss.arraySync(), loss.latentLoss.arraySync()]
            });
          }
          return loss.totalLoss;
        });
      });

      // Use tf.nextFrame to not block the browser.
      await tf.nextFrame();
    }

    logging.logWithDuration('Training finished', startTime, 'MidiMe');
    this.trained = true;
    optimizer.dispose();
  }

  /**
   * Samples sequences from the model prior.
   *
   * @param numSamples The number of samples to return.
   * @returns A latent vector representing a `NoteSequence`. You can pass
   * this latent vector to a `MusicVAE`s `decode` method to convert it to a
   * `NoteSequence`.
   */
  async sample(numSamples = 1) {
    if (!this.initialized) {
      await this.initialize();
    }
    return tf.tidy(() => {
      const randZs = tf.randomNormal([numSamples, this.config['latent_size']]);
      return this.decoder.predict(randZs);
    });
  }

  /**
   * Decodes a batch of latent vectors.
   *
   * @param z The batch of latent vectors, of shape `[numSamples,
   *     this.config['latent_size']]`.
   * @returns A latent vector representing a `NoteSequence`. You can pass
   * this latent vector to a `MusicVAE`s `decode` method to convert it to a
   * `NoteSequence`.
   */
  async decode(z: tf.Tensor2D) {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.decoder.predict(z);
  }

  /**
   * Encodes a batch of latent vectors.
   *
   * @param z The batch of latent vectors, of shape `[numSamples,
   * this.config['input_size']]`. This is the vector that you would get from
   * passing a `NoteSequence` to a `MusicVAE`s `encode` method.
   * @returns A latent vector of size this.config['latent_size'].
   */
  async encode(z: tf.Tensor2D) {
    if (!this.initialized) {
      await this.initialize();
    }
    const [z_, , ] = this.encoder.predict(z) as tf.Tensor[];
    return z_;
  }

  /**
   * Reconstructs an input latent vector.
   *
   * @param z The input latent vector
   * @returns The reconstructed latent vector after running it through the
   *     model.
   */
  predict(z: tf.Tensor) {
    return this.vae.predict(z) as tf.Tensor2D;
  }

  private getEncoder(input: tf.SymbolicTensor) {
    let x = input;

    for (let i = 0; i < this.config['encoder_layers'].length; i++) {
      x = tf.layers
              .dense(
                  {units: this.config['encoder_layers'][i], activation: 'relu'})
              .apply(x) as tf.SymbolicTensor;
    }
    const mu =
        this.getAffineLayers(x, this.config['latent_size'], input, false) as
        tf.SymbolicTensor;

    const sigma =
        this.getAffineLayers(x, this.config['latent_size'], input, true) as
        tf.SymbolicTensor;

    const z = new SamplingLayer().apply([mu, sigma]) as tf.SymbolicTensor;

    return tf.model({inputs: input, outputs: [z, mu, sigma], name: 'encoder'});
  }

  private getDecoder(shape: tf.Shape) {
    const z = tf.input({shape});
    let x = z;

    for (let i = 0; i < this.config['decoder_layers'].length; i++) {
      x = tf.layers
              .dense(
                  {units: this.config['decoder_layers'][i], activation: 'relu'})
              .apply(x) as tf.SymbolicTensor;
    }
    const mu = this.getAffineLayers(x, this.config['input_size'], z, false) as
        tf.SymbolicTensor;
    return tf.model({inputs: z, outputs: mu, name: 'decoder'});
  }

  private loss(
      zMu: tf.Tensor, zSigma: tf.Tensor, yPred: tf.Tensor, yTrue: tf.Tensor):
      {latentLoss: tf.Scalar, reconLoss: tf.Scalar, totalLoss: tf.Scalar} {
    return tf.tidy(() => {
      // How closely the z matches a unit gaussian.
      const latentLoss = this.klLoss(zMu, zSigma);

      // How well we regenerated yTrue.
      const reconLoss = this.reconstructionLoss(yTrue, yPred);

      const totalLoss =
          tf.add(reconLoss, tf.mul(latentLoss, this.config['beta'])) as
          tf.Scalar;
      return {latentLoss, reconLoss, totalLoss};
    });
  }

  reconstructionLoss(yTrue: tf.Tensor, yPred: tf.Tensor): tf.Scalar {
    return tf.tidy(() => {
      // = mse(x,p_x_mu) / 2 'input_sigma ^2
      const se = tf.pow(tf.sub(yTrue, yPred), 2);
      const nll = tf.div(se, tf.mul(2, tf.pow(tf.ones([1]), 2)));
      return tf.mean(tf.sum(nll, -1));
    });
  }

  klLoss(mu: tf.Tensor, sigma: tf.Tensor): tf.Scalar {
    return tf.tidy(() => {
      const mu2 = tf.pow(mu, 2);
      const sigma2 = tf.pow(sigma, 2);

      const term1 = tf.add(1, tf.log(sigma2));
      const term2 = tf.add(mu2, sigma2);
      const term = tf.sub(term1, term2);
      const div = tf.div(tf.mean(tf.sum(term, -1)), 2);
      return tf.mul(-1, div);
    });
  }

  private getAffineLayers(
      x: tf.SymbolicTensor, outputSize: number, z_: tf.SymbolicTensor,
      softplus: boolean) {
    const linear = tf.layers.dense({units: outputSize});
    const output = linear.apply(x);

    if (softplus) {
      return tf.layers.activation({activation: 'softplus'}).apply(output);
    } else {
      return output;
    }
  }
}
