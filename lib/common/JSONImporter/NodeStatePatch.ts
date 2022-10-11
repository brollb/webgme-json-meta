import {NodeSelections} from './NodeSelectors';
import {NodeChangeSet} from './NodeChangeSet';
import {assert, Maybe, NodeSearchUtils, Result, setNested} from './Utils';
import diff from 'changeset';
import Core = GmeClasses.Core;
import JSONImporter from "../JSONImporter";

type PatchFunction = (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections) => Promise<Result<PatchResult, PatchError>>;
type PatchResultPromise = Promise<Result<PatchResult, PatchError>>;

class PatchResult {
    patch: NodeChangeSet;

    constructor(patch) {
        this.patch = patch;
    }

    static Ok(patch: NodeChangeSet) {
        return new PatchResult(patch);
    }
}

class PatchError extends Error {
    constructor(msg: string) {
        super(msg);
    }
}

export interface PatchOperation {
    core: GmeClasses.Core;
    put: PatchFunction;
    delete: PatchFunction;
}

export abstract class NodeStatePatch implements PatchOperation {
    core: GmeClasses.Core;
    nodeSearchUtils: NodeSearchUtils

    constructor(core: GmeClasses.Core, nodeSearchUtils: NodeSearchUtils) {
        this.core = core;
        this.nodeSearchUtils = nodeSearchUtils;
    }

    abstract delete: PatchFunction;
    abstract put: PatchFunction;

    getKeyLengthErrorObject(change: NodeChangeSet, msg: string | null = null): PatchError | null {
        let err: PatchError | null = null;
        if (change.key.length !== 2) {
            err = new PatchError(
                msg === null ? `Complex attributes not currently supported: ${change.key.join(', ')}` : msg
            );
        }
        return err;
    }
}

export class AttributesPatch extends NodeStatePatch {
    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): PatchResultPromise => {
        const err = this.getKeyLengthErrorObject(change);

        if (err) {
            return Result.Error(err);
        }

        const [/*type*/, name] = change.key;
        this.core.setAttribute(node, name, change.value || '');

        return Result.Ok(new PatchResult(change));
    };

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const err = this.getKeyLengthErrorObject(change);
        if (err) {
            return Result.Error(err);
        }

        const [/*type*/, name] = change.key;
        this.core.delAttribute(node, name);
        return Result.Ok(new PatchResult(change));
    };
}

export class AttributeMetaPatch extends NodeStatePatch {
    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const isAttrDeletion = change.key.length === 2;
        const [/*type*/, name] = change.key;
        if (isAttrDeletion) {
            this.core.delAttributeMeta(node, name);
        } else {
            const meta = this.core.getAttributeMeta(node, name);
            const metaChange = {type: 'del', key: change.key.slice(2)};
            const newMeta = diff.apply([metaChange], meta);
            this.core.setAttributeMeta(node, name, newMeta);
        }

        return Result.Ok(new PatchResult(change));
    }

    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, name] = change.key;
        const keys = change.key.slice(2);
        if (keys.length) {
            const value = this.core.getAttributeMeta(node, name);
            setNested(value, keys, change.value);
            this.core.setAttributeMeta(node, name, value);
        } else {
            this.core.setAttributeMeta(node, name, change.value);
        }

        // const result = new Result(Maybe.fromValue<PatchResult>(new PatchResult()), Maybe.none<PatchError>());
        // return Promise.resolve(result);
        return Result.Ok(new PatchResult(change));
    }

}

export class PointersPatch extends NodeStatePatch {
    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const errMsg = `Invalid key for pointer: ${change.key.slice(1).join(', ')}`;
        const err = this.getKeyLengthErrorObject(change, errMsg);
        if (err) {
            return Result.Error(
                err
            )
        }
        const [/*type*/, name] = change.key;
        this.core.delPointer(node, name);
        return Result.Ok(PatchResult.Ok(change));
    }

    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const errMsg = `Invalid key for pointer: ${change.key.slice(1).join(', ')}`;
        const err = this.getKeyLengthErrorObject(change, errMsg);
        if (err) {
            return Result.Error(err);
        }
        const [/*type*/, name] = change.key;
        let target = null;
        let targetPath = null;
        if (change.value !== null) {
            target = change.value !== null ?
                await this.nodeSearchUtils.getNode(node, change.value, resolvedSelectors)
                : null;
            targetPath = this.core.getPath(target);
        }
        const hasChanged = targetPath !== this.core.getPointerPath(node, name);
        if (hasChanged) {
            this.core.setPointer(node, name, target);
        }

        return Result.Ok(PatchResult.Ok(change));
    }
}

export class GuidPatch extends NodeStatePatch {
    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        return Result.Ok(PatchResult.Ok(change));
    }

    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const {value} = change;
        this.core.setGuid(node, value);
        return Result.Ok(PatchResult.Ok(change));
    }
}

export class MixinsPatch extends NodeStatePatch {
    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [, index] = change.key;
        const mixinPath = this.core.getMixinPaths(node)[index];
        this.core.delMixin(node, mixinPath);
        return Result.Ok(PatchResult.Ok(change));
    };

    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [, index] = change.key;
        const oldMixinPath = this.core.getMixinPaths(node)[index];
        if (oldMixinPath) {
            this.core.delMixin(node, oldMixinPath);
        }

        const mixinId = change.value;

        const mixinPath = await this.nodeSearchUtils.getNodeId(node, mixinId, resolvedSelectors);
        const canSet = this.core.canSetAsMixin(node, mixinPath);
        if (canSet.isOk) {
            this.core.addMixin(node, mixinPath);
            return Result.Ok(PatchResult.Ok(change));
        } else {
            const err = new PatchError(
                `Cannot set ${mixinId} as mixin for ${this.core.getPath(node)}: ${canSet.reason}`
            );
            return Result.Error(err);
        }
    };

}

export class PointerMetaPatch extends NodeStatePatch {
    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*"pointer_meta"*/, name, idOrMinMax] = change.key;
        const isNewPointer = change.key.length === 2;

        if (isNewPointer) {
            const meta = change.value;
            this.core.setPointerMetaLimits(node, name, meta.min, meta.max);

            const targets = Object.entries(change.value)
                .filter(pair => {
                    const [key, /*value*/] = pair;
                    return !['min', 'max'].includes(key);
                });

            for (let i = targets.length; i--;) {
                const [nodeId, meta] = targets[i];
                const target = await this.nodeSearchUtils.getNode(node, nodeId, resolvedSelectors);
                this.core.setPointerMetaTarget(node, name, target, meta.min, meta.max);
            }
        } else if (['min', 'max'].includes(idOrMinMax)) {
            const meta = this.core.getPointerMeta(node, name);
            meta[idOrMinMax] = change.value;
            this.core.setPointerMetaLimits(node, name, meta.min, meta.max);
        } else {
            const meta = this.core.getPointerMeta(node, name);
            const target = await this.nodeSearchUtils.getNode(node, idOrMinMax, resolvedSelectors);
            const gmeId = await this.core.getPath(target);
            const keys = change.key.slice(2);
            keys[0] = gmeId;
            setNested(meta, keys, change.value);

            const targetMeta = meta[gmeId];
            this.core.setPointerMetaTarget(node, name, target, targetMeta.min, targetMeta.max);
        }

        return Result.Ok(PatchResult.Ok(change));
    };

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, name, targetId] = change.key;
        const removePointer = targetId === undefined;
        if (removePointer) {
            this.core.delPointerMeta(node, name);
        } else {
            const gmeId = await this.nodeSearchUtils.getNodeId(node, targetId, resolvedSelectors);
            this.core.delPointerMetaTarget(node, name, gmeId);
        }

        return Result.Ok(PatchResult.Ok(change));
    };
}

export class ChildrenPatch extends NodeStatePatch {
    importer: JSONImporter;

    constructor(core: GmeClasses.Core, nodeSearchUtils: NodeSearchUtils, importer: JSONImporter) {
        super(core, nodeSearchUtils);
        this.importer = importer;
    }

    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        try {
            await this.importer.createStateSubTree(change.parentPath, change.value, resolvedSelectors);
            return Result.Ok(PatchResult.Ok(change));
        } catch (err) {
            return Result.Error(new PatchError((err as Error).message));
        }
    };

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        this.core.deleteNode(node);
        return Result.Ok(PatchResult.Ok(change));
    };
}

export class SetsPatch extends NodeStatePatch {
    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, name] = change.key;
        const isNewSet = change.key.length === 2;
        if (isNewSet) {
            this.core.createSet(node, name);
            const memberPaths = change.value;

            for (let i = 0; i < memberPaths.length; i++) {
                const member = await this.nodeSearchUtils.getNode(node, memberPaths[i], resolvedSelectors);
                this.core.addMember(node, name, member);
            }
        } else {
            const member = await this.nodeSearchUtils.getNode(node, change.value, resolvedSelectors);
            this.core.addMember(node, name, member);
        }

        return Result.Ok(PatchResult.Ok(change));
    };

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, name, index] = change.key;
        const removeSet = index === undefined;
        if (removeSet) {
            this.core.delSet(node, name);
        } else {
            const member = this.core.getMemberPaths(node, name)[index];
            this.core.delMember(node, name, member);
        }
        return Result.Ok(PatchResult.Ok(change));
    };

}

export class MemberAttributesPatch extends NodeStatePatch {
    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, set, nodeId, name] = change.key;
        const isNewSet = nodeId === undefined;
        const isNewMember = name === undefined;
        if (isNewSet || isNewMember) {
            const changesets = Object.entries(change.value)
                .map(entry => ({
                    type: 'put',
                    key: change.key.concat([entry[0]]),
                    value: entry[1],
                }));

            for (let i = changesets.length; i--;) {
                await this.put(node, changesets[i], resolvedSelectors);
            }
        } else {
            const gmeId = await this.nodeSearchUtils.getNodeId(node, nodeId, resolvedSelectors);
            this.core.setMemberAttribute(node, set, gmeId, name, change.value);
        }

        return Result.Ok(PatchResult.Ok(change));
    };

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, set, nodeId, name] = change.key;
        const gmeId = await this.nodeSearchUtils.getNodeId(node, nodeId, resolvedSelectors);
        const deleteAllAttributes = name === undefined;
        const isMember = this.core.getMemberPaths(node, set).includes(gmeId);
        let error: Maybe<PatchError> = Maybe.none();
        if (isMember) {
            const attributeNames = deleteAllAttributes ?
                this.core.getMemberAttributeNames(node, set, gmeId) : [name];

            attributeNames.forEach(name => {
                this.core.delMemberAttribute(node, set, gmeId, name);
            });
        } else {
            if (!deleteAllAttributes) {
                const member = await this.core.loadByPath(this.nodeSearchUtils.getRoot(), gmeId);
                const memberName = this.core.getAttribute(member, 'name');
                const memberDisplay = `${memberName} (${gmeId})`;

                throw new Error(`Cannot delete partial member attributes for ${memberDisplay}`);
            }
        }

        return Result.Ok(PatchResult.Ok(change));
    };

}


export class MemberRegistryPatch extends NodeStatePatch {
    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, set, nodeId, name] = change.key;
        const isNewSet = nodeId === undefined;
        const isNewMember = name === undefined;
        if (isNewSet || isNewMember) {
            const changesets = Object.entries(change.value)
                .map(entry => ({
                    type: 'put',
                    key: change.key.concat([entry[0]]),
                    value: entry[1],
                }));

            for (let i = changesets.length; i--;) {
                await this.put(node, changesets[i], resolvedSelectors);
            }
        } else {
            const gmeId = await this.nodeSearchUtils.getNodeId(node, nodeId, resolvedSelectors);
            const isNested = change.key.length > 4;
            if (isNested) {
                const value = this.core.getMemberRegistry(node, set, gmeId, name);
                setNested(value, change.key.slice(4), change.value);
                this.core.setMemberRegistry(node, set, gmeId, name, value);
            } else {
                this.core.setMemberRegistry(node, set, gmeId, name, change.value);
            }
        }

        return Result.Ok(PatchResult.Ok(change));
    }

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, set, nodeId, name] = change.key;
        const gmeId = await this.nodeSearchUtils.getNodeId(node, nodeId, resolvedSelectors);
        const deleteAllRegistryValues = name === undefined;
        const isMember = this.core.getMemberPaths(node, set).includes(gmeId);
        let error = Maybe.none<PatchError>();
        if (isMember) {
            const attributeNames = deleteAllRegistryValues ?
                this.core.getMemberRegistryNames(node, set, gmeId) : [name];

            attributeNames.forEach(name => {
                this.core.delMemberRegistry(node, set, gmeId, name);
            });
        } else {
            if (!deleteAllRegistryValues) {
                const member = await this.core.loadByPath(this.nodeSearchUtils.getRoot(), gmeId);
                const memberName = this.core.getAttribute(member, 'name');
                const memberDisplay = `${memberName} (${gmeId})`;

                const err = new PatchError(`Cannot delete partial member registry values for ${memberDisplay}`);
                return Result.Error(err);
            }
        }
        return Result.Ok(PatchResult.Ok(change));
    }
}

export class RegistryPatch extends NodeStatePatch {
    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*type*/, name] = change.key;
        const keys = change.key.slice(2);
        if (keys.length) {
            const value = this.core.getRegistry(node, name);
            setNested(value, keys, change.value);
            this.core.setRegistry(node, name, value);
        } else {
            this.core.setRegistry(node, name, change.value);
        }

        return Result.Ok(PatchResult.Ok(change));
    };

    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const err = this.getKeyLengthErrorObject(change);
        let success = Maybe.none<PatchResult>();
        if (err) {
            return Result.Error(err);
        }
        const [/*type*/, name] = change.key;
        this.core.delRegistry(node, name);
        return Result.Ok(PatchResult.Ok(change));
    };
}


export class ChildrenMetaPatch extends NodeStatePatch {
    delete = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*"children_meta"*/, idOrMinMax] = change.key;
        const isNodeId = !['min', 'max'].includes(idOrMinMax);
        if (isNodeId) {
            const gmeId = await this.nodeSearchUtils.getNodeId(node, idOrMinMax, resolvedSelectors);
            this.core.delChildMeta(node, gmeId);
        }

        return Result.Ok(PatchResult.Ok(change));
    }

    put = async (node: Core.Node, change: NodeChangeSet, resolvedSelectors: NodeSelections): Promise<Result<PatchResult, PatchError>> => {
        const [/*"children_meta"*/, idOrUndef] = change.key;
        const isAddingContainment = !idOrUndef;
        const isNewChildDefinition = typeof idOrUndef === 'string';
        if (isAddingContainment) {
            const {min, max} = change.value;
            this.core.setChildrenMetaLimits(node, min, max);
            const childEntries = Object.entries(change.value).filter(pair => !['min', 'max'].includes(pair[0]));
            for (let i = 0; i < childEntries.length; i++) {
                const [nodeId, {min, max}] = childEntries[i];
                const childNode = await this.nodeSearchUtils.getNode(node, nodeId, resolvedSelectors);
                this.core.setChildMeta(node, childNode, min, max);
                this.core.setChildMeta(node, childNode, min, max);
            }
        } else if (isNewChildDefinition) {
            const nodeId = idOrUndef;
            const {min, max} = change.value;
            const childNode = await this.nodeSearchUtils.getNode(node, nodeId, resolvedSelectors);
            this.core.setChildMeta(node, childNode, min, max);
        }

        return Result.Ok(PatchResult.Ok(change));
    }
}