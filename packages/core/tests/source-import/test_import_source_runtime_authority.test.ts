/** Source-runtime ownership tests split from import preview reconciliation. */

import { describe, expect, it } from "vitest";
import { candidateSourceRuntimes } from "../../src/orchestration/import-preview";
import { makeReadResult, makeServiceConfiguration } from "./fixtures/import-service-test-fixtures";

describe("Core import source-runtime authority", () => {
    it("fails closed for unavailable or unbound source capabilities and canonically orders sources", async () => {
        const read = await makeReadResult();
        const candidate = read.candidates[0];
        const obligation = read.sourceReadObligations[0];
        const report = read.sourceParseReports[0];
        const disposition = report?.readEntryDispositions[0];
        if (
            candidate === undefined ||
            obligation === undefined ||
            report === undefined ||
            disposition === undefined ||
            disposition.disposition === "ignored" ||
            read.readTarget.sourceSelector.selectorKind !== "probe_roots"
        ) {
            throw new Error("source-runtime fixture is incomplete");
        }

        const unavailable = makeServiceConfiguration(async () => read, {
            resolveSourceCapabilityAgentRuntimeId: () => null,
        });
        expect(() => candidateSourceRuntimes(unavailable, read, candidate)).toThrow(/source capability is no longer registered/);

        const unbound = structuredClone(read);
        for (const sourceReport of unbound.sourceParseReports) {
            for (const entryDisposition of sourceReport.readEntryDispositions) {
                if (entryDisposition.disposition !== "ignored") entryDisposition.candidateIds = [];
            }
        }
        expect(() =>
            candidateSourceRuntimes(
                makeServiceConfiguration(async () => unbound),
                unbound,
                unbound.candidates[0]!,
            ),
        ).toThrow(/not bound to a registered source agent runtime/);

        const secondFingerprint = `sha256:${"e".repeat(64)}` as const;
        read.sourceReadObligations.push({
            ...obligation,
            sourceReadObligationId: "second-obligation",
            sourceCapabilityFingerprint: secondFingerprint,
        });
        report.readEntryDispositions.push({
            ...disposition,
            readEntryDispositionId: "second-disposition",
            sourceReadObligationId: "second-obligation",
        });
        const observed = read.readTarget.sourceSelector.observation.observedAgentRuntimes[0]!;
        read.readTarget.sourceSelector.observation.observedAgentRuntimes = [
            { ...observed, agentRuntimeId: "Z_RUNTIME", versionText: "2" },
            { ...observed, agentRuntimeId: "A_RUNTIME", versionText: "1" },
        ];
        const ordered = candidateSourceRuntimes(
            makeServiceConfiguration(async () => read, {
                resolveSourceCapabilityAgentRuntimeId: (_adapterId, fingerprint) =>
                    fingerprint === secondFingerprint ? "A_RUNTIME" : "Z_RUNTIME",
            }),
            read,
            candidate,
        );
        expect(ordered).toEqual([
            { agentRuntimeId: "A_RUNTIME", versionText: "1" },
            { agentRuntimeId: "Z_RUNTIME", versionText: "2" },
        ]);

        const userSelected = await makeReadResult();
        const userSelectedCandidate = userSelected.candidates[0];
        const userSelectedRoot = userSelected.sourceRoots[0];
        if (userSelectedCandidate === undefined || userSelectedRoot === undefined) {
            throw new Error("user-selected source fixture is incomplete");
        }
        const platformContext =
            userSelected.readTarget.sourceSelector.selectorKind === "probe_roots"
                ? userSelected.readTarget.sourceSelector.observation.platformContext
                : userSelected.readTarget.sourceSelector.platformContext;
        userSelected.readTarget.sourceSelector = {
            selectorKind: "user_selected_root",
            platformContext,
            binding: {
                sourceRoot: userSelectedRoot,
                assetScope: "global",
                projectRootPath: "",
            },
        };
        expect(
            candidateSourceRuntimes(
                makeServiceConfiguration(async () => userSelected),
                userSelected,
                userSelectedCandidate,
            ),
        ).toEqual([{ agentRuntimeId: "IMPORT_FAKE_CLI", versionText: "" }]);
    });
});
