/*! The migration table.

This is a table listing pairs of (from_bucket_id, to_bucket_id).  A pair
in this table indicates that a user with a Lox credential containing
from_bucket_id (and possibly meeting other conditions as well) is
entitled to exchange their credential for one with to_bucket_id.  (Note
that the credentials contain the bucket attributes, which include both
the id and the bucket decrytpion key, but the table just contains the
bucket ids.) */

use curve25519_dalek::ristretto::CompressedRistretto;
#[cfg(feature = "bridgeauth")]
use curve25519_dalek::ristretto::RistrettoBasepointTable;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;

use sha2::Digest;
use sha2::Sha256;

use aes_gcm::aead::{generic_array::GenericArray, Aead};
use aes_gcm::{Aes128Gcm, KeyInit};
#[cfg(feature = "bridgeauth")]
use rand::RngCore;

use std::collections::HashMap;

#[cfg(feature = "bridgeauth")]
use serde::{Deserialize, Serialize};

#[cfg(feature = "bridgeauth")]
use super::bridge_table;
use super::cred::Migration;
#[cfg(feature = "bridgeauth")]
use super::IssuerPrivKey;
#[cfg(feature = "bridgeauth")]
use super::CMZ_B_TABLE;

/// Each (plaintext) entry in the returned migration table is serialized
/// into this many bytes
pub const MIGRATION_BYTES: usize = 96;

/// The size of an encrypted entry in the returned migration table
pub const ENC_MIGRATION_BYTES: usize = MIGRATION_BYTES + 12 + 16;

/// The type of migration table: TrustUpgrade is for migrations from
/// untrusted (level 0) 1-bridge buckets to trusted (level 1) 3-bridge
/// buckets.  Blockage is for migrations that drop you down two levels
/// (level 3 to 1, level 4 to 2) because the bridges in your current
/// bucket were blocked.
pub enum MigrationType {
    TrustUpgrade,
    Blockage,
}

impl From<MigrationType> for Scalar {
    /// Convert a MigrationType into the Scalar value that represents
    /// it in the Migration credential
    fn from(m: MigrationType) -> Self {
        match m {
            MigrationType::TrustUpgrade => 0u32,
            MigrationType::Blockage => 1u32,
        }
        .into()
    }
}

/// The migration table
#[derive(Default, Debug, Serialize, Deserialize)]
#[cfg(feature = "bridgeauth")]
pub struct MigrationTable {
    pub table: HashMap<u32, u32>,
    pub migration_type: Scalar,
}

/// Create an encrypted Migration credential for returning to the user
/// in the trust promotion protocol.
///
/// Given the attributes of a Migration credential, produce a serialized
/// version (containing only the to_bucket and the MAC, since the
/// receiver will already know the id and from_bucket), encrypted with
/// H2(id, from_bucket, Qk), for the Qk portion of the MAC on the
/// corresponding Migration Key credential (with fixed Pk, given as a
/// precomputed multiplication table).  Return the label H1(id,
/// from_attr_i, Qk_i) and the encrypted Migration credential.  H1 and
/// H2 are the first 16 bytes and the second 16 bytes respectively of
/// the SHA256 hash of the input.
#[cfg(feature = "bridgeauth")]
pub fn encrypt_cred(
    id: &Scalar,
    from_bucket: &Scalar,
    to_bucket: &Scalar,
    migration_type: &Scalar,
    Pktable: &RistrettoBasepointTable,
    migration_priv: &IssuerPrivKey,
    migrationkey_priv: &IssuerPrivKey,
) -> ([u8; 16], [u8; ENC_MIGRATION_BYTES]) {
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    let mut rng = rand::thread_rng();

    // Compute the Migration Key credential MAC Qk
    let Qk = &(migrationkey_priv.x[0]
        + migrationkey_priv.x[1] * id
        + migrationkey_priv.x[2] * from_bucket)
        * Pktable;

    // Compute a MAC (P, Q) on the Migration credential
    let b = Scalar::random(&mut rng);
    let P = &b * Btable;
    let Q = &(b
        * (migration_priv.x[0]
            + migration_priv.x[1] * id
            + migration_priv.x[2] * from_bucket
            + migration_priv.x[3] * to_bucket
            + migration_priv.x[4] * migration_type))
        * Btable;

    // Serialize (to_bucket, P, Q)
    let mut credbytes: [u8; MIGRATION_BYTES] = [0; MIGRATION_BYTES];
    credbytes[0..32].copy_from_slice(to_bucket.as_bytes());
    credbytes[32..64].copy_from_slice(P.compress().as_bytes());
    credbytes[64..].copy_from_slice(Q.compress().as_bytes());

    // Pick a random nonce
    let mut noncebytes: [u8; 12] = [0; 12];
    rng.fill_bytes(&mut noncebytes);
    let nonce = GenericArray::from_slice(&noncebytes);

    // Compute the hash of (id, from_bucket, Qk)
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.update(from_bucket.as_bytes());
    hasher.update(Qk.compress().as_bytes());
    let fullhash = hasher.finalize();

    // Create the encryption key from the 2nd half of the hash
    let aeskey = GenericArray::from_slice(&fullhash[16..]);
    // Encrypt
    let cipher = Aes128Gcm::new(aeskey);
    let ciphertext: Vec<u8> = cipher.encrypt(nonce, credbytes.as_ref()).unwrap();
    let mut enccredbytes: [u8; ENC_MIGRATION_BYTES] = [0; ENC_MIGRATION_BYTES];
    enccredbytes[..12].copy_from_slice(&noncebytes);
    enccredbytes[12..].copy_from_slice(ciphertext.as_slice());

    // Use the first half of the above hash as the label
    let mut label: [u8; 16] = [0; 16];
    label[..].copy_from_slice(&fullhash[..16]);

    (label, enccredbytes)
}

/// Create an encrypted Migration credential for returning to the user
/// in the trust promotion protocol, given the ids of the from and to
/// buckets, and the migration type, and using a BridgeTable to get the
/// bucket keys.
///
/// Otherwise the same as encrypt_cred, above, except it returns an
/// Option in case the passed ids were invalid.
#[cfg(feature = "bridgeauth")]
pub fn encrypt_cred_ids(
    id: &Scalar,
    from_id: u32,
    to_id: u32,
    migration_type: &Scalar,
    bridgetable: &bridge_table::BridgeTable,
    Pktable: &RistrettoBasepointTable,
    migration_priv: &IssuerPrivKey,
    migrationkey_priv: &IssuerPrivKey,
) -> Option<([u8; 16], [u8; ENC_MIGRATION_BYTES])> {
    // Look up the bucket keys and form the attributes (Scalars)
    let fromkey = bridgetable.keys.get(&from_id)?;
    let tokey = bridgetable.keys.get(&to_id)?;
    Some(encrypt_cred(
        id,
        &bridge_table::to_scalar(from_id, fromkey),
        &bridge_table::to_scalar(to_id, tokey),
        migration_type,
        Pktable,
        migration_priv,
        migrationkey_priv,
    ))
}

#[cfg(feature = "bridgeauth")]
impl MigrationTable {
    /// Create a MigrationTable of the given MigrationType
    pub fn new(table_type: MigrationType) -> Self {
        Self {
            table: Default::default(),
            migration_type: table_type.into(),
        }
    }

    /// For each entry in the MigrationTable, use encrypt_cred_ids to
    /// produce an entry in an output HashMap (from labels to encrypted
    /// Migration credentials).
    pub fn encrypt_table(
        &self,
        id: &Scalar,
        bridgetable: &bridge_table::BridgeTable,
        Pktable: &RistrettoBasepointTable,
        migration_priv: &IssuerPrivKey,
        migrationkey_priv: &IssuerPrivKey,
    ) -> HashMap<[u8; 16], [u8; ENC_MIGRATION_BYTES]> {
        self.table
            .iter()
            .filter_map(|(from_id, to_id)| {
                encrypt_cred_ids(
                    id,
                    *from_id,
                    *to_id,
                    &self.migration_type,
                    bridgetable,
                    Pktable,
                    migration_priv,
                    migrationkey_priv,
                )
            })
            .collect()
    }
}

/// Decrypt an encrypted Migration credential given Qk, the known
/// attributes id and from_bucket for the Migration credential as well
/// as the known migration type, and a HashMap mapping labels to
/// ciphertexts.
pub fn decrypt_cred(
    Qk: &RistrettoPoint,
    lox_id: &Scalar,
    from_bucket: &Scalar,
    migration_type: MigrationType,
    enc_migration_table: &HashMap<[u8; 16], [u8; ENC_MIGRATION_BYTES]>,
) -> Option<Migration> {
    // Compute the hash of (id, from_bucket, Qk)
    let mut hasher = Sha256::new();
    hasher.update(lox_id.as_bytes());
    hasher.update(from_bucket.as_bytes());
    hasher.update(Qk.compress().as_bytes());
    let fullhash = hasher.finalize();

    // Use the first half of the above hash as the label
    let mut label: [u8; 16] = [0; 16];
    label[..].copy_from_slice(&fullhash[..16]);

    // Look up the label in the HashMap
    let ciphertext = enc_migration_table.get(&label)?;

    // Create the decryption key from the 2nd half of the hash
    let aeskey = GenericArray::from_slice(&fullhash[16..]);

    // Decrypt
    let nonce = GenericArray::from_slice(&ciphertext[..12]);
    let cipher = Aes128Gcm::new(aeskey);
    let plaintext: Vec<u8> = match cipher.decrypt(nonce, ciphertext[12..].as_ref()) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let plaintextbytes = plaintext.as_slice();
    let mut to_bucket_bytes: [u8; 32] = [0; 32];
    to_bucket_bytes.copy_from_slice(&plaintextbytes[..32]);
    let to_bucket = Scalar::from_bytes_mod_order(to_bucket_bytes);
    let P = CompressedRistretto::from_slice(&plaintextbytes[32..64])
        .expect("Unable to extract P from bucket")
        .decompress()?;
    let Q = CompressedRistretto::from_slice(&plaintextbytes[64..])
        .expect("Unable to extract Q from bucket")
        .decompress()?;

    Some(Migration {
        P,
        Q,
        lox_id: *lox_id,
        from_bucket: *from_bucket,
        to_bucket,
        migration_type: migration_type.into(),
    })
}
