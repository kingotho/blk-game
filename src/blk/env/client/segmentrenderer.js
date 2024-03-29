/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('blk.env.client.SegmentRenderer');

goog.require('blk.env.Chunk');
goog.require('blk.env.MaterialFlags');
goog.require('blk.env.UpdatePriority');
goog.require('blk.graphics.LineBuffer');
goog.require('gf.graphics.Resource');
goog.require('gf.vec.BoundingBox');
goog.require('goog.reflect');
goog.require('goog.vec.Mat4');
goog.require('goog.vec.Vec3');
goog.require('goog.vec.Vec4');
goog.require('wtfapi.trace');
goog.require('wtfapi.trace.events');



/**
 * Handles chunk segment rendering.
 * Caches geometry for a chunk. Does not match the size of chunks, only regions
 * of them. Many segments fit together to make a single chunk.
 *
 * @constructor
 * @extends {gf.graphics.Resource}
 * @param {!blk.env.client.ViewRenderer} viewRenderer Parent map renderer.
 * @param {!blk.graphics.RenderState} renderState Render state manager.
 * @param {!blk.env.Chunk} chunk Chunk to render.
 * @param {number} by Block offset Y in chunk.
 */
blk.env.client.SegmentRenderer = function(
    viewRenderer, renderState, chunk, by) {
  goog.base(this, renderState.graphicsContext);

  /**
   * Unique ID that can be used for caching.
   * @type {number}
   */
  this.id = blk.env.client.SegmentRenderer.nextId_++;

  /**
   * Parent view renderer.
   * @type {!blk.env.client.ViewRenderer}
   */
  this.viewRenderer = viewRenderer;

  /**
   * Render state manager.
   * @type {!blk.graphics.RenderState}
   */
  this.renderState = renderState;

  /**
   * Chunk to render.
   * @type {!blk.env.Chunk}
   */
  this.chunk = chunk;

  /**
   * Block offset in chunk Y.
   * @type {number}
   */
  this.by = by;

  /**
   * Chunk world matrix transform.
   * @type {!goog.vec.Mat4.Type}
   */
  this.worldMatrix = goog.vec.Mat4.createFloat32FromValues(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      chunk.x, chunk.y + by, chunk.z, 1);

  /**
   * Chunk center point, in world coordinates.
   * @type {!goog.vec.Vec3.Float32}
   */
  this.centerCoordinates = goog.vec.Vec3.createFloat32FromValues(
      chunk.x + blk.env.client.SegmentRenderer.SIZE / 2,
      chunk.y + by + blk.env.client.SegmentRenderer.SIZE / 2,
      chunk.z + blk.env.client.SegmentRenderer.SIZE / 2);

  /**
   * Bounding box.
   * @type {!gf.vec.BoundingBox}
   */
  this.boundingBox = gf.vec.BoundingBox.create();

  /**
   * Rough bounding sphere for the segment.
   * @type {!goog.vec.Vec4.Float32}
   */
  this.boundingSphere = goog.vec.Vec4.createFloat32FromValues(
      this.centerCoordinates[0],
      this.centerCoordinates[1],
      this.centerCoordinates[2],
      blk.env.client.SegmentRenderer.SIZE);

  /**
   * Shared block builder.
   * @private
   * @type {!blk.graphics.BlockBuilder}
   */
  this.blockBuilder_ = renderState.blockBuilder;

  /**
   * Block set, for faster access.
   * @private
   * @type {!blk.env.BlockSet}
   */
  this.blockSet_ = chunk.map.blockSet;

  /**
   * True if the chunk geometry is out of date.
   * @type {boolean}
   */
  this.dirty = true;

  /**
   * Current face buffer generated with the block builder.
   * @private
   * @type {WebGLBuffer}
   */
  this.faceBuffer_ = null;

  /**
   * Number of elements in the current face buffer.
   * @private
   * @type {number}
   */
  this.faceBufferElementCount_ = 0;

  /**
   * Estimated number of bytes used by the renderer.
   * @type {number}
   */
  this.estimatedSize = 0;

  /**
   * Sort key used by the build queue. Don't use for anything else.
   * @type {number}
   */
  this.sortKey = 0;

  /**
   * The last frame number that the renderer was visible in the viewport.
   * @type {number}
   */
  this.lastFrameInViewport = 0;

  /**
   * Whether the chunk is queued for a build.
   * @type {boolean}
   */
  this.queuedForBuild = false;

  /**
   * The priority of the chunk in the build queue, if it is queued.
   * @type {blk.env.UpdatePriority}
   */
  this.queuePriority = blk.env.UpdatePriority.LOAD;

  /**
   * Whether to enable debug visuals.
   * @private
   * @type {boolean}
   */
  this.debugVisuals_ = false;

  /**
   * Debug line buffer. Only initialzed in debug mode.
   * @protected
   * @type {blk.graphics.LineBuffer}
   */
  this.debugLineBuffer = null;
};
goog.inherits(blk.env.client.SegmentRenderer, gf.graphics.Resource);


/**
 * @override
 */
blk.env.client.SegmentRenderer.prototype.disposeInternal = function() {
  this.setDebugVisuals(false);

  goog.base(this, 'disposeInternal');
};


/**
 * Next segment ID.
 * @private
 * @type {number}
 */
blk.env.client.SegmentRenderer.nextId_ = 0;


/**
 * Size, in blocks, of a chunk renderer.
 * @const
 * @type {number}
 */
blk.env.client.SegmentRenderer.SIZE = 16;


/**
 * Bit shift for segment Y.
 * @const
 * @type {number}
 */
blk.env.client.SegmentRenderer.SHIFT_Y = 4;


/**
 * Number of segments per chunk in Y.
 * @const
 * @type {number}
 */
blk.env.client.SegmentRenderer.SEGMENTS_Y =
    blk.env.Chunk.SIZE_Y / blk.env.client.SegmentRenderer.SIZE;


/**
 * @override
 */
blk.env.client.SegmentRenderer.prototype.discard = function() {
  var gl = this.graphicsContext.gl;

  // Delete buffer
  gl.deleteBuffer(this.faceBuffer_);
  this.faceBuffer_ = null;
  this.faceBufferElementCount_ = 0;
  this.estimatedSize = 0;

  if (this.debugLineBuffer) {
    goog.dispose(this.debugLineBuffer);
    this.debugLineBuffer = null;
  }

  goog.base(this, 'discard');
};


/**
 * @override
 */
blk.env.client.SegmentRenderer.prototype.restore = function() {
  goog.base(this, 'restore');

  if (this.debugVisuals_) {
    this.setDebugVisuals(false);
    this.setDebugVisuals(true);
  }

  // Invalidate the chunk and re-add to the build queue
  this.viewRenderer.invalidateSegment(
      this.chunk.x, this.chunk.y + this.by, this.chunk.z,
      blk.env.UpdatePriority.LOAD);
};


/**
 * Marks the chunk as needing to be rebuilt.
 */
blk.env.client.SegmentRenderer.prototype.invalidate = function() {
  this.dirty = true;
};


blk.env.client.SegmentRenderer.build0_ = wtfapi.trace.events.createScope(
    'blk.env.client.SegmentRenderer#build:fast');
blk.env.client.SegmentRenderer.build1_ = wtfapi.trace.events.createScope(
    'blk.env.client.SegmentRenderer#build:slow');


/**
 * Rebuilds the chunk geometry.
 * @return {number} Size delta (e.g., +5 = new size is 5b larger than before).
 */
blk.env.client.SegmentRenderer.prototype.build = function() {
  this.dirty = false;

  var blockSet = this.blockSet_;
  var blockAtlas = this.renderState.blockAtlas;
  var blockData = this.chunk.blockData;
  var texCoords = blk.env.client.SegmentRenderer.tmpVec4_;
  var neighbors = blk.env.client.SegmentRenderer.tmpFaces_;

  var scope = blk.env.client.SegmentRenderer.build0_();
  // Optimized path for interior blocks (that are known not to be affected
  // by other chunks)
  // This reduces the complexity and massively speeds things up
  // This handles all Y (as they are in the same chunk), X and Z neighbors
  // are handled by the code below
  var bymin = this.by;
  var bymax = this.by + blk.env.client.SegmentRenderer.SIZE - 1;
  for (var by = bymin; by <= bymax; by++) {
    for (var bz = 1; bz < blk.env.client.SegmentRenderer.SIZE - 1; bz++) {
      for (var bx = 1; bx < blk.env.client.SegmentRenderer.SIZE - 1; bx++) {
        var bo = bx + bz * blk.env.Chunk.STRIDE_Z + by * blk.env.Chunk.STRIDE_Y;
        var data = blockData[bo];
        if (!(data >> 8)) {
          continue;
        }
        neighbors[0] = blockData[bo + blk.env.Chunk.STRIDE_Z] >> 8;
        neighbors[1] = blockData[bo - blk.env.Chunk.STRIDE_Z] >> 8;
        neighbors[2] = (by >= blk.env.Chunk.SIZE_Y - 1) ?
            0 : blockData[bo + blk.env.Chunk.STRIDE_Y] >> 8;
        neighbors[3] = (by <= 0 ?
            data : blockData[bo - blk.env.Chunk.STRIDE_Y]) >> 8;
        neighbors[4] = blockData[bo + 1] >> 8;
        neighbors[5] = blockData[bo - 1] >> 8;
        var block = blockSet.getBlockWithId(data >> 8);
        for (var n = 0; n < 6; n++) {
          if (!neighbors[n] ||
              (neighbors[n] != data >> 8 &&
                  (blockSet.getBlockWithId(neighbors[n]).material.flags &
                      blk.env.MaterialFlags.MERGE))) {
            var slot = block.getFaceSlot(
                bx, by, bz,
                /** @type {blk.env.Face} */ (n),
                (data >> 16) & 0xFF,
                data & 0xFFFF);
            // TODO(benvanik): more efficient texCoord lookup
            blockAtlas.getSlotCoords(slot, texCoords);
            this.blockBuilder_.addFace(
                /** @type {blk.env.Face} */ (n),
                bx, by - this.by, bz,
                texCoords);
          }
        }
      }
    }
  }
  wtfapi.trace.leaveScope(scope);

  scope = blk.env.client.SegmentRenderer.build1_();
  /** @type {!Array.<blk.env.Chunk>} */
  var neighborChunks = new Array(4);
  neighborChunks[0] = this.viewRenderer.view.getChunk(
      this.chunk.x - blk.env.Chunk.SIZE_XZ, this.chunk.y, this.chunk.z);
  neighborChunks[1] = this.viewRenderer.view.getChunk(
      this.chunk.x + blk.env.Chunk.SIZE_XZ, this.chunk.y, this.chunk.z);
  neighborChunks[2] = this.viewRenderer.view.getChunk(
      this.chunk.x, this.chunk.y, this.chunk.z - blk.env.Chunk.SIZE_XZ);
  neighborChunks[3] = this.viewRenderer.view.getChunk(
      this.chunk.x, this.chunk.y, this.chunk.z + blk.env.Chunk.SIZE_XZ);

  // Slow path that checks each side of the cube by first caching the neighbor
  // chunk and then reusing that for queries
  // Handles X and Z (Y is handled above)
  var bx, bz;
  // -Z
  bx = 0;
  for (bz = 0; bz < blk.env.client.SegmentRenderer.SIZE - 1; bz++) {
    this.addFaces_(bx, bymin, bymax, bz, neighborChunks);
  }
  // +X
  bz = blk.env.client.SegmentRenderer.SIZE - 1;
  for (bx = 0; bx < blk.env.client.SegmentRenderer.SIZE - 1; bx++) {
    this.addFaces_(bx, bymin, bymax, bz, neighborChunks);
  }
  // +Z
  bx = blk.env.client.SegmentRenderer.SIZE - 1;
  for (bz = 1; bz < blk.env.client.SegmentRenderer.SIZE; bz++) {
    this.addFaces_(bx, bymin, bymax, bz, neighborChunks);
  }
  // -X
  bz = 0;
  for (bx = 1; bx < blk.env.client.SegmentRenderer.SIZE; bx++) {
    this.addFaces_(bx, bymin, bymax, bz, neighborChunks);
  }
  wtfapi.trace.leaveScope(scope);

  // Finish the build
  var gl = this.graphicsContext.gl;
  var results = this.blockBuilder_.finish(this.faceBuffer_);
  this.faceBuffer_ = results.buffer;
  this.faceBufferElementCount_ = results.elementCount;

  if (goog.DEBUG && this.faceBuffer_) {
    this.faceBuffer_['displayName'] = 'Segment ' +
        this.chunk.x + ',' + (this.chunk.y + this.by) + ',' + this.chunk.z;
  }

  var oldSize = this.estimatedSize;
  this.estimatedSize = results.bytesUsed;
  return this.estimatedSize - oldSize;
};


/**
 * Adds faces to the face buffer for the given block.
 * @private
 * @param {number} bx Block X, in chunk coordinates.
 * @param {number} bymin Block Y, in chunk coordinates.
 * @param {number} bymax Block Y, in chunk coordinates.
 * @param {number} bz Block Z, in chunk coordinates.
 * @param {!Array.<blk.env.Chunk>} neighborChunks Neighboring chunks.
 */
blk.env.client.SegmentRenderer.prototype.addFaces_ = function(
    bx, bymin, bymax, bz, neighborChunks) {
  var blockSet = this.blockSet_;
  var blockAtlas = this.renderState.blockAtlas;
  var blockData = this.chunk.blockData;
  var texCoords = blk.env.client.SegmentRenderer.tmpVec4_;
  var neighbors = blk.env.client.SegmentRenderer.tmpFaces_;

  var cx = this.chunk.x;
  var cz = this.chunk.z;

  for (var by = bymin; by <= bymax; by++) {
    var bo = bx + bz * blk.env.Chunk.STRIDE_Z + by * blk.env.Chunk.STRIDE_Y;
    var data = blockData[bo];
    if (!(data >> 8)) {
      continue;
    }

    if (bz == blk.env.client.SegmentRenderer.SIZE - 1) {
      neighbors[0] = neighborChunks[3] ?
          neighborChunks[3].getBlock(cx + bx, by, cz + bz + 1) >> 8 : 0;
    } else {
      neighbors[0] = blockData[bo + blk.env.Chunk.STRIDE_Z] >> 8;
    }
    if (!bz) {
      neighbors[1] = neighborChunks[2] ?
          neighborChunks[2].getBlock(cx + bx, by, cz + bz - 1) >> 8 : 0;
    } else {
      neighbors[1] = blockData[bo - blk.env.Chunk.STRIDE_Z] >> 8;
    }
    neighbors[2] = (by >= blk.env.Chunk.SIZE_Y - 1) ?
        0 : blockData[bo + blk.env.Chunk.STRIDE_Y] >> 8;
    neighbors[3] = (by <= 0 ?
        data : blockData[bo - blk.env.Chunk.STRIDE_Y]) >> 8;
    if (bx == blk.env.client.SegmentRenderer.SIZE - 1) {
      neighbors[4] = neighborChunks[1] ?
          neighborChunks[1].getBlock(cx + bx + 1, by, cz + bz) >> 8 : 0;
    } else {
      neighbors[4] = blockData[bo + 1] >> 8;
    }
    if (!bx) {
      neighbors[5] = neighborChunks[0] ?
          neighborChunks[0].getBlock(cx + bx - 1, by, cz + bz) >> 8 : 0;
    } else {
      neighbors[5] = blockData[bo - 1] >> 8;
    }

    var block = blockSet.getBlockWithId(data >> 8);
    for (var n = 0; n < 6; n++) {
      if (!neighbors[n] ||
          (neighbors[n] != data >> 8 &&
              (blockSet.getBlockWithId(neighbors[n]).material.flags &
                  blk.env.MaterialFlags.MERGE))) {
        var slot = block.getFaceSlot(
            bx, by, bz,
            /** @type {blk.env.Face} */ (n),
            (data >> 16) & 0xFF,
            data & 0xFFFF);
        // TODO(benvanik): more efficient texCoord lookup
        blockAtlas.getSlotCoords(slot, texCoords);
        this.blockBuilder_.addFace(
            /** @type {blk.env.Face} */ (n),
            bx, by - this.by, bz,
            texCoords);
      }
    }
  }
};


/**
 * Toggles the debug visuals.
 * @param {boolean} value New value.
 */
blk.env.client.SegmentRenderer.prototype.setDebugVisuals = function(value) {
  if (this.debugVisuals_ == value) {
    return;
  }
  this.debugVisuals_ = value;
  if (value) {
    // Create
    this.debugLineBuffer = new blk.graphics.LineBuffer(
        this.graphicsContext);
    this.addDebugVisuals_(this.debugLineBuffer);
  } else {
    // Drop
    goog.dispose(this.debugLineBuffer);
    this.debugLineBuffer = null;
  }
};


/**
 * Adds debug visuals to the line buffer.
 * @private
 * @param {!blk.graphics.LineBuffer} buffer Line buffer.
 */
blk.env.client.SegmentRenderer.prototype.addDebugVisuals_ =
    function(buffer) {
  buffer.addCube(
      goog.vec.Vec3.createFloat32FromValues(0, 0, 0),
      goog.vec.Vec3.createFloat32FromValues(
          blk.env.client.SegmentRenderer.SIZE,
          blk.env.client.SegmentRenderer.SIZE,
          blk.env.client.SegmentRenderer.SIZE),
      0xFFFFFFFF);
};


/**
 * @return {boolean} True if there is any renderable data in this segment.
 */
blk.env.client.SegmentRenderer.prototype.hasData = function() {
  return this.queuedForBuild || this.estimatedSize > 0;
};


/**
 * Renders the segment.
 * @param {!gf.RenderFrame} frame Current render frame.
 * @param {!gf.vec.Viewport} viewport Current viewport.
 */
blk.env.client.SegmentRenderer.prototype.render =
    function(frame, viewport) {
  if (this.faceBufferElementCount_) {
    this.blockBuilder_.draw(viewport, this.worldMatrix,
        this.faceBuffer_, this.faceBufferElementCount_);
  }
};


/**
 * Renders debug visuals.
 * @param {!gf.RenderFrame} frame Current render frame.
 * @param {!gf.vec.Viewport} viewport Current viewport.
 */
blk.env.client.SegmentRenderer.prototype.renderDebug =
    function(frame, viewport) {
  if (this.debugLineBuffer) {
    this.debugLineBuffer.draw(this.renderState, viewport, this.worldMatrix);
  }
};


/**
 * Temp vec4 for math.
 * @private
 * @type {!goog.vec.Vec4.Float32}
 */
blk.env.client.SegmentRenderer.tmpVec4_ = goog.vec.Vec4.createFloat32();


/**
 * Temp uint16 6 element array.
 * @private
 * @type {!Uint16Array}
 */
blk.env.client.SegmentRenderer.tmpFaces_ = new Uint16Array(6);


blk.env.client.SegmentRenderer = wtfapi.trace.instrumentType(
    blk.env.client.SegmentRenderer, 'blk.env.client.SegmentRenderer',
    goog.reflect.object(blk.env.client.SegmentRenderer, {
      build: 'build'
    }));
