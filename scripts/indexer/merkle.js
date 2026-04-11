/**
 * indexer/merkle.js
 * Builds merkle trees from EvidenceSnapshot arrays and generates proofs.
 *
 * Leaf encoding matches DeviationAdjudicator._buildLeaf():
 *   keccak256(abi.encodePacked(timestamp, realisedApy, tvlUsd, updateCount))
 *
 * Types:
 *   timestamp    uint48  — seconds
 *   realisedApy  uint32  — basis points
 *   tvlUsd       uint128 — 1e6 scaled USD
 *   updateCount  uint32
 */

const { MerkleTree } = require('merkletreejs');
const keccak256       = require('keccak256');
const { ethers }      = require('ethers');

/**
 * Encodes a single snapshot into a 32-byte leaf.
 * Must match DeviationAdjudicator._buildLeaf() exactly.
 */
function encodeLeaf(snapshot) {
  const encoded = ethers.solidityPacked(
    ['uint48', 'uint32', 'uint128', 'uint32'],
    [
      snapshot.timestamp,
      snapshot.realisedApy,
      BigInt(snapshot.tvlUsd),
      snapshot.updateCount,
    ]
  );
  return keccak256(Buffer.from(encoded.slice(2), 'hex'));
}

/**
 * Builds a merkle tree from an ordered array of snapshots.
 * Returns { tree, root, leaves }.
 */
function buildTree(snapshots) {
  if (!snapshots.length) {
    throw new Error('Cannot build merkle tree from empty snapshot array');
  }

  const leaves = snapshots.map(encodeLeaf);
  const tree   = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root   = '0x' + tree.getRoot().toString('hex');

  return { tree, root, leaves };
}

/**
 * Generates a merkle proof for a specific snapshot within a tree.
 * Returns proof as array of hex strings (matches Solidity bytes32[]).
 */
function getProof(tree, snapshot) {
  const leaf  = encodeLeaf(snapshot);
  const proof = tree.getProof(leaf).map(p => '0x' + p.data.toString('hex'));
  return proof;
}

/**
 * Verifies a proof locally before submitting on-chain.
 * Mirrors the Solidity _verifyProof() logic.
 */
function verifyProof(tree, snapshot) {
  const leaf = encodeLeaf(snapshot);
  return tree.verify(tree.getProof(leaf), leaf, tree.getRoot());
}

/**
 * Rebuilds a tree from stored snapshots and returns proof for a given index.
 * Convenience function for the proof API endpoint.
 */
function buildProofForIndex(snapshots, index) {
  if (index < 0 || index >= snapshots.length) {
    throw new Error(`Index ${index} out of range (${snapshots.length} snapshots)`);
  }
  const { tree } = buildTree(snapshots);
  return getProof(tree, snapshots[index]);
}

module.exports = { encodeLeaf, buildTree, getProof, verifyProof, buildProofForIndex };
