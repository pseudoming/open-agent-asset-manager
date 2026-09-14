/** Candidate-native inputs, including bounded operation-local fragment provenance. */

import type { PosixRelativePath } from "./primitives";

export interface CandidateNativeRepresentationFileInput {
    relativePath: PosixRelativePath;
    contentKind: "text" | "binary";
    mediaType: string;
    bytes: Uint8Array;
    executable: boolean;
    /** Core-verified operation-local extraction from one already observed container file. */
    fragmentOrigin?: {
        fragmentKind: "jsonc_top_level_property_value";
        observedReadEntryId: string;
        propertyName: string;
    };
}

export interface CandidateNativeRepresentationDirectoryInput {
    relativePath: PosixRelativePath;
    /** Exact operation-local directory observation that authorizes this member. */
    observedReadEntryIds: string[];
}

export type CandidateNativeRepresentationInput =
    | { representationSource: "canonical_files"; dialectId: string }
    | {
          representationSource: "separate_files";
          dialectId: string;
          files: CandidateNativeRepresentationFileInput[];
      }
    | {
          representationSource: "separate_file_graph";
          dialectId: string;
          directories: CandidateNativeRepresentationDirectoryInput[];
          files: CandidateNativeRepresentationFileInput[];
      };
