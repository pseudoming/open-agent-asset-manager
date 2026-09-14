import { describe, expect, it } from "vitest";
import {
    assertAdapterDialectContracts,
    createVersionDialectRegistry,
    snapshotAdapterDialectContracts,
} from "../../src/catalog/version-dialect-registry";
import {
    computePortableEntryDialectContractFingerprint,
    computePortableSelectorDialectContractFingerprint,
} from "../../src/foundation/fingerprint";
import type {
    AdapterDialectContractSetV1,
    AdapterPortableEntryDialectContractV1,
    AdapterPortableSelectorDialectContractV1,
    PortableEntryDialectUseV1,
    PortableSelectorDialectUseV1,
} from "../../src/types";
import { makePortableEntryDialectContract, makePortableSelectorDialectContract } from "./fixtures/dialect-contracts";

describe("portable dialect registry", () => {
    it("snapshots definitions, computes identities, and isolates callback mutation", () => {
        let entryCalls = 0;
        let selectorCalls = 0;
        let sourceCalls = 0;
        const entry = makePortableEntryDialectContract(
            "Workflow",
            "workflow_instruction",
            "fixture-workflow-entry-v1",
            (input) => {
                entryCalls += 1;
                input.use.dialectId = "mutated-v1";
                if (input.canonical.kind === "Workflow") input.canonical.typeData.name = "mutated";
                return true;
            },
        );
        const selector = makePortableSelectorDialectContract("Workflow", "workflow_model", "fixture-model-selector-v1", (use) => {
            selectorCalls += 1;
            if (use.value.valueKind === "relative_tier") use.value.selector = "mutated";
            return true;
        });
        entry.validateSourceApplicability = (source) => {
            sourceCalls += 1;
            source.versionText = "mutated";
            return true;
        };
        selector.validateSourceApplicability = entry.validateSourceApplicability;
        const contractSource: AdapterDialectContractSetV1 = {
            native: [],
            restoration: [],
            portableEntries: [entry],
            portableSelectors: [selector],
        };
        const snapshot = snapshotAdapterDialectContracts(contractSource);
        const registry = createVersionDialectRegistry([], [], snapshot.portableEntries, snapshot.portableSelectors);
        const resolvedEntry = registry.getPortableEntry("Workflow", "workflow_instruction", "fixture-workflow-entry-v1");
        const resolvedSelector = registry.getPortableSelector("Workflow", "workflow_model", "fixture-model-selector-v1");
        expect(resolvedEntry?.contractFingerprint).toBe(computePortableEntryDialectContractFingerprint(entry.definition));
        expect(resolvedSelector?.contractFingerprint).toBe(
            computePortableSelectorDialectContractFingerprint(selector.definition),
        );

        const entryUse: PortableEntryDialectUseV1 = {
            kind: "Workflow",
            field: "workflow_instruction",
            dialectId: "fixture-workflow-entry-v1",
            logicalPath: "review.md",
        };
        const canonical = workflowCanonical();
        expect(
            resolvedEntry?.validateCanonicalEntry({
                use: entryUse,
                versionStatus: "complete",
                canonical,
                canonicalFiles: [],
            }),
        ).toBe(true);
        expect(entryUse.dialectId).toBe("fixture-workflow-entry-v1");
        expect(canonical.typeData.name).toBe("review");

        const selectorUse: PortableSelectorDialectUseV1 = {
            kind: "Workflow",
            field: "workflow_model",
            dialectId: "fixture-model-selector-v1",
            value: { valueKind: "relative_tier", selector: "fast", relativeTier: 1 },
        };
        expect(resolvedSelector?.validateSelector(selectorUse)).toBe(true);
        expect(selectorUse.value).toEqual({
            valueKind: "relative_tier",
            selector: "fast",
            relativeTier: 1,
        });
        expect(entryCalls).toBe(1);
        expect(selectorCalls).toBe(1);
        const sourceRuntime = { agentRuntimeId: "FIXTURE_CLI", versionText: "1.0" };
        expect(resolvedEntry?.validateSourceApplicability(sourceRuntime)).toBe(true);
        expect(resolvedSelector?.validateSourceApplicability(sourceRuntime)).toBe(true);
        expect(sourceRuntime).toEqual({ agentRuntimeId: "FIXTURE_CLI", versionText: "1.0" });
        expect(sourceCalls).toBe(2);
        expect(Object.isFrozen(snapshot.portableEntries)).toBe(true);
        expect(Object.isFrozen(snapshot.portableEntries[0]?.definition)).toBe(true);

        entry.definition.dialectId = "caller-mutated-v2";
        selector.validateSelector = () => false;
        entry.validateSourceApplicability = () => false;
        expect(snapshot.portableEntries[0]?.definition.dialectId).toBe("fixture-workflow-entry-v1");
        expect(resolvedSelector?.validateSelector(selectorUse)).toBe(true);
        expect(resolvedEntry?.validateSourceApplicability(sourceRuntime)).toBe(true);
    });

    it("keeps unknown, throwing, and non-boolean portable contracts fail closed", () => {
        const throwingEntry = makePortableEntryDialectContract("Skill", "skill_entry", "throwing-skill-entry-v1", () => {
            throw new Error("entry fault");
        });
        throwingEntry.validateSourceApplicability = () => {
            throw new Error("source fault");
        };
        const nonbooleanSelector = makePortableSelectorDialectContract(
            "Subagent",
            "subagent_tool",
            "nonboolean-tool-selector-v1",
            (() => "yes") as never,
        );
        nonbooleanSelector.validateSourceApplicability = (() => "yes") as never;
        const throwingSourceSelector = makePortableSelectorDialectContract(
            "Subagent",
            "subagent_permission",
            "throwing-permission-selector-v1",
            () => {
                throw new Error("selector fault");
            },
        );
        throwingSourceSelector.validateSourceApplicability = () => {
            throw new Error("source fault");
        };
        const registry = createVersionDialectRegistry([], [], [throwingEntry], [nonbooleanSelector, throwingSourceSelector]);
        expect(registry.getPortableEntry("Skill", "skill_entry", "missing-v1")).toBeNull();
        expect(registry.getPortableSelector("Subagent", "subagent_tool", "missing-v1")).toBeNull();
        expect(
            registry.getPortableEntry("Skill", "skill_entry", "throwing-skill-entry-v1")?.validateCanonicalEntry({
                use: {
                    kind: "Skill",
                    field: "skill_entry",
                    dialectId: "throwing-skill-entry-v1",
                    logicalPath: "SKILL.md",
                },
                versionStatus: "complete",
                canonical: {} as never,
                canonicalFiles: [],
            }),
        ).toBe(false);
        expect(
            registry.getPortableEntry("Skill", "skill_entry", "throwing-skill-entry-v1")?.validateSourceApplicability({
                agentRuntimeId: "FIXTURE_CLI",
                versionText: "1.0",
            }),
        ).toBe(false);
        expect(
            registry
                .getPortableSelector("Subagent", "subagent_permission", "throwing-permission-selector-v1")
                ?.validateSourceApplicability({
                    agentRuntimeId: "FIXTURE_CLI",
                    versionText: "1.0",
                }),
        ).toBe(false);
        expect(
            registry
                .getPortableSelector("Subagent", "subagent_tool", "nonboolean-tool-selector-v1")
                ?.validateSourceApplicability({
                    agentRuntimeId: "FIXTURE_CLI",
                    versionText: "1.0",
                }),
        ).toBe(false);
        expect(
            registry.getPortableSelector("Subagent", "subagent_permission", "throwing-permission-selector-v1")?.validateSelector({
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: "throwing-permission-selector-v1",
                value: {
                    valueKind: "permission_effect",
                    selector: "plan",
                    effect: "read_only",
                },
            }),
        ).toBe(false);
        expect(
            registry.getPortableSelector("Subagent", "subagent_tool", "nonboolean-tool-selector-v1")?.validateSelector({
                kind: "Subagent",
                field: "subagent_tool",
                dialectId: "nonboolean-tool-selector-v1",
                value: { valueKind: "selector", selector: "Read" },
            }),
        ).toBe(false);
    });

    it("rejects duplicate, unversioned, wrong-family, wrong-kind, and malformed definitions", () => {
        const entry = () => makePortableEntryDialectContract("Workflow", "workflow_instruction", "fixture-workflow-entry-v1");
        const selector = () => makePortableSelectorDialectContract("Workflow", "workflow_model", "fixture-model-selector-v1");
        expect(() => createVersionDialectRegistry([], [], [entry(), entry()], [])).toThrow(/duplicate portable entry/);
        expect(() => createVersionDialectRegistry([], [], [], [selector(), selector()])).toThrow(/duplicate portable selector/);

        const malformed: AdapterDialectContractSetV1[] = [];
        const addEntry = (mutate: (contract: AdapterPortableEntryDialectContractV1) => void) => {
            const contract = entry();
            mutate(contract);
            malformed.push(contractSet([contract], []));
        };
        const addSelector = (mutate: (contract: AdapterPortableSelectorDialectContractV1) => void) => {
            const contract = selector();
            mutate(contract);
            malformed.push(contractSet([], [contract]));
        };
        addEntry((contract) => {
            contract.definition.dialectId = "unversioned";
        });
        addEntry((contract) => {
            contract.definition.kind = "Skill";
        });
        addEntry((contract) => {
            contract.definition.field = "workflow_model" as never;
        });
        addEntry((contract) => {
            contract.definition.applicableAgentRuntimeIds = [];
        });
        addEntry((contract) => {
            contract.definition.applicableAgentRuntimeIds = ["Z_CLI", "A_CLI"];
        });
        addEntry((contract) => {
            contract.definition.applicableAgentRuntimeIds = ["A_CLI", "A_CLI"];
        });
        addEntry((contract) => {
            contract.validateCanonicalEntry = 1 as never;
        });
        addEntry((contract) => {
            contract.validateSourceApplicability = null as never;
        });
        malformed.push(contractSet([null as never], []));
        addSelector((contract) => {
            contract.definition.field = "workflow_instruction" as never;
        });
        addSelector((contract) => {
            contract.definition.selectorSemanticsValidator.componentVersion = 0;
        });
        addSelector((contract) => {
            (contract.definition as unknown as { extra: boolean }).extra = true;
        });
        addSelector((contract) => {
            contract.validateSelector = null as never;
        });
        addSelector((contract) => {
            contract.validateSourceApplicability = null as never;
        });
        malformed.push(contractSet([], [null as never]));
        for (const contractSetValue of malformed) {
            expect(() => assertAdapterDialectContracts(contractSetValue)).toThrow();
        }
    });
});

function contractSet(
    portableEntries: AdapterPortableEntryDialectContractV1[],
    portableSelectors: AdapterPortableSelectorDialectContractV1[],
): AdapterDialectContractSetV1 {
    return { native: [], restoration: [], portableEntries, portableSelectors };
}

function workflowCanonical() {
    return {
        kind: "Workflow" as const,
        typeData: {
            schemaVersion: 2 as const,
            name: "review",
            description: "Review changes",
            implementation: {
                kind: "instructions" as const,
                instructionDialectId: "fixture-workflow-entry-v1",
                execution: {
                    mode: "caller" as const,
                    agent: { mode: "agent_runtime_default" as const },
                    model: { mode: "inherit" as const },
                    effort: { mode: "inherit" as const },
                    shell: { mode: "none" as const },
                },
                toolPolicy: {
                    preapproved: [],
                    denied: [],
                    otherwise: "inherit_agent_runtime_policy" as const,
                },
            },
            invocation: {
                commandNames: ["review"],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}
