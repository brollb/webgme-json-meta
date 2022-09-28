/// <reference path="./webgme/webgme.d.ts" />
import type {
    Diff,
    GMEAttributeMetaType,
    GMEAttributesType, GMEGuidToOutAttrType,
    GMEJSONNodeType,
    GMEPointersType,
    GMERelationRuleType, GMESetsType, MemberRegistryType
} from './Models';

import {OmittedProperties} from './OmittedProperties';
import {Constants} from './Utils';


type Core = GmeClasses.Core;

export class Exporter {
    core: Core;
    rootNode: Core.Node;
    omitted: OmittedProperties;
    promiseQueue: Promise<any>[];

    constructor(core: Core, rootNode: Core.Node) {
        this.core = core
        this.rootNode = rootNode;
        this.omitted = new OmittedProperties();
        this.promiseQueue = [];
    }

    async _metaDictToGuids(meta_dict: Core.RelationRule | null): Promise<GMERelationRuleType> {
        if (meta_dict === null) return meta_dict;
        return Object.fromEntries(
            await Promise.all(Object.entries(meta_dict).map(async ([key, value]) => {
                if (key === 'min' || key === 'max') return [key, value];
                const node = await this.core.loadByPath(this.rootNode, key);
                return [this.core.getGuid(node), value];
            }))
        );
    }

    clearPromiseQueue(): void {
        this.promiseQueue = [];
    }

    setOmittedProperties(omitted: OmittedProperties): void {
        this.omitted = omitted;
    }

    async toJSON(node: Core.Node, omit: OmittedProperties | boolean = new OmittedProperties()): Promise<Partial<GMEJSONNodeType>> {
        if (typeof omit === 'boolean') {
            const omitList = omit ? ['children'] : [];
            omit = new OmittedProperties(omitList);
        } // Backwards compatible with shallow

        this.setOmittedProperties(omit);
        return await this._toJSON(node);
    }

    async _toJSON(node: Core.Node): Promise<Partial<GMEJSONNodeType>> {
        const json = {
            id: this.core.getGuid(node),
            path: this.core.getPath(node),
            guid: this.core.getGuid(node),
            attributes: {},
            attribute_meta: {},
            pointers: {},
            pointer_meta: {},
            mixins: [],
            registry: {},
            sets: {},
            member_registry: {},
            member_attributes: {},
            children: [],
            children_meta: {},
        }

        this.omitted.forEach(toOmit => delete json[toOmit]);

        this.clearPromiseQueue();
        Object.keys(json).forEach(key => {
            if (this[key]) {
                this[key](node, json);
            }
        });
        await Promise.all(this.promiseQueue);

        this.clearPromiseQueue();
        return json;
    }

    attributes(node: Core.Node, json: Pick<GMEJSONNodeType, 'attributes'>) {
        this.core.getOwnAttributeNames(node).forEach(name => {
            json.attributes[name] = this.core.getAttribute(node, name);
        });
    }

    attribute_meta(node: Core.Node, json: Pick<GMEJSONNodeType, 'attribute_meta'>) {
        this.core.getOwnValidAttributeNames(node).forEach(name => {
            json.attribute_meta[name] = this.core.getAttributeMeta(node, name);
        });
    }

    sets(node: Core.Node, json: Pick<GMEJSONNodeType, ['sets', 'member_attributes', 'member_registry']>) {
        this.promiseQueue
            .push(...this.core.getOwnSetNames(node)
                .filter(name => name !== '_mixins')
                .map(async name => {
                    const paths = this.core.getMemberPaths(node, name);
                    const members = await Promise.all(paths.map(path => this.core.loadByPath(this.rootNode, path)));
                    const memberGuids = members.map(member => this.core.getGuid(member));
                    json.sets[name] = memberGuids;

                    if (!this.omitted.has('member_attributes')) { // Alternatives to this closure variable?
                        members.forEach(member => {
                            let guid = this.core.getGuid(member);
                            let memberPath = this.core.getPath(member);

                            json.member_attributes[name] = {};
                            json.member_attributes[name][guid] = {};
                            this.core.getMemberAttributeNames(node, name, memberPath).forEach(attrName => {
                                const value = this.core.getMemberAttribute(node, name, memberPath, attrName);
                                json.member_attributes[name][guid][attrName] = value;
                            });
                        });
                    }
                    if (!this.omitted.has('member_registry')) {
                        members.forEach(member => {
                            let guid = this.core.getGuid(member);
                            let memberPath = this.core.getPath(member);

                            json.member_registry[name] = {};
                            json.member_registry[name][guid] = {};
                            this.core.getMemberRegistryNames(node, name, memberPath).forEach(regName => {
                                const value = this.core.getMemberRegistry(node, name, memberPath, regName);
                                json.member_registry[name][guid][regName] = value;
                            });
                        });
                    }
                }));
    }

    pointers(node: Core.Node, json: Pick<GMEJSONNodeType, 'pointers'>) {
        this.promiseQueue.push(...this.core.getOwnPointerNames(node).map(async name => {
            const path = this.core.getPointerPath(node, name);
            if (path) {
                const target = await this.core.loadByPath(this.rootNode, path);
                json.pointers[name] = this.core.getGuid(target);
            } else {
                json.pointers[name] = path;
            }
        }));
        const baseNode = this.core.getBase(node);
        json.pointers.base = baseNode && this.core.getGuid(baseNode);
    }

    registry(node: Core.Node, json: Pick<GMEJSONNodeType, 'registry'>) {
        this.core.getOwnRegistryNames(node).forEach(name => {
            json.registry[name] = this.core.getRegistry(node, name);
        });
    }

    children(node, json,) {
        this.promiseQueue.push((async () => {
            const children = await this.core.loadChildren(node);
            json.children = await Promise.all(
                children.map(child => this._toJSON(child))
            );
        })());
    }

    children_meta(node, json: Pick<GMEJSONNodeType, 'children_meta'>) {
        this.promiseQueue.push(
            this._metaDictToGuids(this.core.getChildrenMeta(node))
                .then(children_meta => children_meta ? json.children_meta = children_meta : () => {
                })
        );
    }
}

