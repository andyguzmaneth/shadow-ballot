/**
 * Anamorphic Signatures Proof of Concept
 *
 * This demonstrates how to hide secret messages inside ECDSA signatures
 * by controlling the nonce 'k' used during signing.
 *
 * Based on "Anamorphic Signatures: Secrecy from a Dictator Who Only Permits Authentication!"
 * (Kutylowski et al., CRYPTO 2023)
 */

const EC = require('elliptic').ec;
const BN = require('bn.js');
const { keccak256 } = require('ethereum-cryptography/keccak');
const { hexToBytes, bytesToHex, utf8ToBytes } = require('ethereum-cryptography/utils');

// Initialize secp256k1 curve (used by Ethereum and Bitcoin)
const ec = new EC('secp256k1');

/**
 * ECDSA Signature with Custom Nonce
 *
 * Unlike standard ECDSA, this allows us to specify the nonce 'k'
 * This is the key to anamorphic signatures - we control k to encode hidden data
 */
function signWithCustomNonce(privateKeyHex, messageHash, k) {
    const keyPair = ec.keyFromPrivate(privateKeyHex);
    const msgHash = Buffer.from(messageHash, 'hex');

    // Get curve parameters
    const n = ec.curve.n;

    // Ensure k is in valid range [1, n-1]
    if (k.gte(n) || k.lte(new BN(0))) {
        throw new Error('Invalid nonce k: must be in range [1, n-1]');
    }

    // Compute r = (k * G).x mod n
    const point = ec.g.mul(k);
    const r = point.getX().umod(n);

    if (r.isZero()) {
        throw new Error('Invalid r value (zero)');
    }

    // Compute s = k^-1 * (H(m) + r * privateKey) mod n
    const kInv = k.invm(n);
    const eBN = new BN(msgHash);
    const s = kInv.mul(eBN.add(r.mul(keyPair.getPrivate()))).umod(n);

    if (s.isZero()) {
        throw new Error('Invalid s value (zero)');
    }

    return {
        r: r.toString('hex', 64),
        s: s.toString('hex', 64),
        recoveryParam: point.getY().isOdd() ? 1 : 0
    };
}

/**
 * Derive nonce k from shared secret and hidden message
 *
 * This is the "randomness replacement" technique:
 * Instead of k = random(), we use k = KDF(secret, message, hiddenData)
 *
 * The receiver can reconstruct k if they know the secret and can guess hiddenData
 */
function deriveNonceFromSecret(sharedSecret, publicMessage, hiddenMessage) {
    const n = ec.curve.n;

    // Combine all inputs
    const input = Buffer.concat([
        Buffer.from(sharedSecret, 'hex'),
        Buffer.from(publicMessage, 'hex'),
        Buffer.from(hiddenMessage)
    ]);

    // Hash to derive k (use keccak256 for Ethereum compatibility)
    let hash = keccak256(input);
    let k = new BN(hash);

    // Ensure k is in valid range, rehash if needed
    let counter = 0;
    while (k.gte(n) || k.lte(new BN(0))) {
        const counterBuf = Buffer.alloc(4);
        counterBuf.writeUInt32BE(counter);
        hash = keccak256(Buffer.concat([input, counterBuf]));
        k = new BN(hash);
        counter++;

        if (counter > 1000) {
            throw new Error('Failed to derive valid k after 1000 attempts');
        }
    }

    return k;
}

/**
 * Create an anamorphic signature
 *
 * This creates a valid ECDSA signature that:
 * 1. Validates correctly for the public message
 * 2. Contains a hidden message embedded in the nonce choice
 * 3. Is indistinguishable from a normal signature to outsiders
 */
function createAnamorphicSignature(privateKeyHex, sharedSecret, publicMessage, hiddenMessage) {
    // Hash the public message (Ethereum-style)
    const messageHash = bytesToHex(keccak256(utf8ToBytes(publicMessage)));

    // Derive k from the shared secret and hidden message
    const k = deriveNonceFromSecret(sharedSecret, messageHash, hiddenMessage);

    // Sign with this specific k
    const signature = signWithCustomNonce(privateKeyHex, messageHash, k);

    return {
        signature,
        messageHash,
        publicMessage
    };
}

/**
 * Extract hidden message from an anamorphic signature
 *
 * This uses brute force for short messages (as mentioned in the papers).
 * The receiver:
 * 1. Knows the shared secret
 * 2. Sees the signature (r, s) and public message
 * 3. Tries different hidden messages to see which one produces matching r
 */
function extractHiddenMessage(signature, publicMessage, sharedSecret, candidateMessages) {
    const messageHash = bytesToHex(keccak256(utf8ToBytes(publicMessage)));
    const targetR = signature.r;

    // Try each candidate hidden message
    for (const candidate of candidateMessages) {
        // Derive what k would be for this candidate
        const k = deriveNonceFromSecret(sharedSecret, messageHash, candidate);

        // Compute what r would be
        const point = ec.g.mul(k);
        const r = point.getX().umod(ec.curve.n);
        const rHex = r.toString('hex', 64);

        // Check if it matches the signature's r value
        if (rHex === targetR) {
            return candidate;
        }
    }

    return null; // Hidden message not found
}

/**
 * Verify a signature is valid (standard ECDSA verification)
 */
function verifySignature(publicKeyHex, messageHash, signature) {
    const keyPair = ec.keyFromPublic(publicKeyHex, 'hex');
    return keyPair.verify(messageHash, signature);
}

/**
 * Create a normal (non-anamorphic) signature for comparison
 */
function createNormalSignature(privateKeyHex, publicMessage) {
    const keyPair = ec.keyFromPrivate(privateKeyHex);
    const messageHash = bytesToHex(keccak256(utf8ToBytes(publicMessage)));
    const signature = keyPair.sign(messageHash);

    return {
        signature: {
            r: signature.r.toString('hex', 64),
            s: signature.s.toString('hex', 64),
            recoveryParam: signature.recoveryParam
        },
        messageHash,
        publicMessage
    };
}

module.exports = {
    createAnamorphicSignature,
    extractHiddenMessage,
    createNormalSignature,
    verifySignature,
    ec
};
