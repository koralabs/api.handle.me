// Module augmentation: the api maintains a per-handle WS1 asset-label registry set on the
// StoredHandle (and mirrors it into a derived redis hash for fast MPT root builds). It is
// api-internal indexing state, so it's augmented here rather than added to the shared
// kora-labs-common type (which a different major version of the engine also consumes).
import '@koralabs/kora-labs-common';

declare module '@koralabs/kora-labs-common' {
    interface StoredHandle {
        /**
         * WS1 asset-label registry value: the sorted hex set of CIP-67 label prefixes
         * ({001,002,003,004}) this handle currently holds. Maintained by the scanner on
         * mint/burn of those label assets. Absent or '' == the empty set. The handle's KEY
         * stays in the MPT until its 222/000 is burnt; this field only mutates the value.
         */
        registry_labels?: string;
    }
}
