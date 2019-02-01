"use strict";
/**
 * @license
 * Copyright (c) 2018 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
(function () {
    if (window.define) {
        /* The loader was already loaded, make sure we don't reset it's state. */
        return;
    }
    // Set to true for more logging. Anything guarded by an
    // `if (debugging)` check will not appear in the final output.
    const debugging = false;
    /**
     * Transition the given module to the given state.
     *
     * Does not ensure that the transition is legal.
     * Calls onNextStateChange callbacks.
     */
    function stateTransition(module, newState, newStateData) {
        if (debugging) {
            console.log(`${module.url} transitioning to state ${newState}`);
        }
        const mutatedModule = module;
        mutatedModule.state = newState;
        mutatedModule.stateData = newStateData;
        if (mutatedModule.onNextStateChange.length > 0) {
            const callbacks = mutatedModule.onNextStateChange.slice();
            mutatedModule.onNextStateChange.length = 0;
            for (const callback of callbacks) {
                callback();
            }
        }
        return mutatedModule;
    }
    /**
     * A global map from a fully qualified module URLs to module objects.
     */
    const registry = Object.create(null);
    let pendingDefine = undefined;
    let topLevelScriptIdx = 0;
    let previousTopLevelUrl = undefined;
    let baseUrl = getBaseUrl();
    /** Begin loading a module from the network. */
    function load(module) {
        const mutatedModule = stateTransition(module, "Loading" /* Loading */, undefined);
        const script = document.createElement('script');
        script.src = module.url;
        // Crossorigin attribute could be the empty string - preserve this.
        if (module.crossorigin !== null) {
            script.setAttribute('crossorigin', module.crossorigin);
        }
        /**
         * Remove our script tags from the document after they have loaded/errored, to
         * reduce the number of nodes. Since the file load order is arbitrary and not
         * the order in which we execute modules, these scripts aren't even helpful
         * for debugging, and they might give a false impression of the execution
         * order.
         */
        function removeScript() {
            try {
                //document.head.removeChild(script);
            }
            catch ( /* Something else removed the script. We don't care. */_a) { /* Something else removed the script. We don't care. */
            }
        }
        script.onload = () => {
            let deps, moduleBody;
            if (pendingDefine !== undefined) {
                [deps, moduleBody] = pendingDefine();
            }
            else {
                // The script did not make a call to define(), otherwise the global
                // callback would have been set. That's fine, we can execute immediately
                // because we can't have any dependencies.
                deps = [];
                moduleBody = undefined;
            }
            beginWaitingForTurn(mutatedModule, deps, moduleBody);
            removeScript();
        };
        script.onerror = () => {
            fail(module, new TypeError('Failed to fetch ' + module.url));
            removeScript();
        };
        document.head.appendChild(script);
        return mutatedModule;
    }
    /** Start loading the module's dependencies, but don't execute anything yet. */
    function beginWaitingForTurn(module, deps, moduleBody) {
        const [args, depModules] = loadDeps(module, deps);
        const stateData = {
            args,
            deps: depModules,
            moduleBody,
        };
        return stateTransition(module, "WaitingForTurn" /* WaitingForTurn */, stateData);
    }
    function loadDeps(module, depSpecifiers) {
        const args = [];
        const depModules = [];
        for (const depSpec of depSpecifiers) {
            if (depSpec === 'exports') {
                args.push(module.exports);
                continue;
            }
            if (depSpec === 'require') {
                args.push(function (deps, onExecuted, onError) {
                    const [args, depModules] = loadDeps(module, deps);
                    executeDependenciesInOrder(depModules, () => {
                        if (onExecuted) {
                            onExecuted.apply(null, args);
                        }
                    }, onError);
                });
                continue;
            }
            if (depSpec === 'meta') {
                args.push({
                    // We append "#<script index>" to top-level scripts so that they have
                    // unique keys in the registry. We don't want to see that here.
                    url: (module.isTopLevel === true) ?
                        module.url.substring(0, module.url.lastIndexOf('#')) :
                        module.url
                });
                continue;
            }
            // We have a dependency on a real module.
            const dependency = getModule(resolveUrl(module.urlBase, depSpec), module.crossorigin);
            args.push(dependency.exports);
            depModules.push(dependency);
            if (dependency.state === "Initialized" /* Initialized */) {
                load(dependency);
            }
        }
        return [args, depModules];
    }
    /**
     * Start executing our dependencies, in order, as they become available.
     * Once they're all executed, execute our own module body, if any.
     */
    function beginWaitingOnDeps(module) {
        const mutatedModule = stateTransition(module, "WaitingOnDeps" /* WaitingOnDeps */, module.stateData);
        executeDependenciesInOrder(module.stateData.deps, () => execute(mutatedModule), (e) => fail(mutatedModule, e));
        return mutatedModule;
    }
    /** Runs the given module body. */
    function execute(module) {
        const stateData = module.stateData;
        if (stateData.moduleBody != null) {
            try {
                let result = stateData.moduleBody.apply(null, stateData.args);
/*
                if (result !== undefined) {
                    module.exports = result;
                    stateData.args[0] = result;
                }
*/
            }
            catch (e) {
                return fail(module, e);
            }
        }
        return stateTransition(module, "Executed" /* Executed */, undefined);
    }
    /**
     * Called when a module has failed to load, either becuase its script errored,
     * or because one of its transitive dependencies errored.
     */
    function fail(mod, error) {
        if (mod.isTopLevel === true) {
            setTimeout(() => {
                // Top level modules have no way to handle errors other than throwing
                // an uncaught exception.
                throw error;
            });
        }
        return stateTransition(mod, "Failed" /* Failed */, error);
    }
    /**
     * @param deps The dependencies to execute, if they have not already executed.
     * @param onAllExecuted Called after all dependencies have executed.
     * @param onFailed Called if any dependency fails.
     */
    function executeDependenciesInOrder(deps, onAllExecuted, onFailed) {
        const nextDep = deps.shift();
        if (nextDep === undefined) {
            if (onAllExecuted) {
                onAllExecuted();
            }
            return;
        }
        if (nextDep.state === "WaitingOnDeps" /* WaitingOnDeps */) {
            if (debugging) {
                console.log(`Cycle detected while importing ${nextDep.url}`);
            }
            // Do not wait on the dep that introduces a cycle, continue on as though it
            // were not there.
            executeDependenciesInOrder(deps, onAllExecuted, onFailed);
            return;
        }
        waitForModuleWhoseTurnHasCome(nextDep, () => {
            executeDependenciesInOrder(deps, onAllExecuted, onFailed);
        }, onFailed);
    }
    /**
     * This method does two things: it waits for a module to execute, and it
     * will transition that module to WaitingOnDeps. This is the only place where we
     * transition a non-top-level module from WaitingForTurn to WaitingOnDeps.
     */
    function waitForModuleWhoseTurnHasCome(dependency, onExecuted, onFailed) {
        switch (dependency.state) {
            case "WaitingForTurn" /* WaitingForTurn */:
                beginWaitingOnDeps(dependency);
                waitForModuleWhoseTurnHasCome(dependency, onExecuted, onFailed);
                return;
            case "Failed" /* Failed */:
                if (onFailed) {
                    onFailed(dependency.stateData);
                }
                return;
            case "Executed" /* Executed */:
                onExecuted();
                return;
            // Nothing to do but wait
            case "Loading" /* Loading */:
            case "WaitingOnDeps" /* WaitingOnDeps */:
                dependency.onNextStateChange.push(() => waitForModuleWhoseTurnHasCome(dependency, onExecuted, onFailed));
                return;
            // These cases should never happen.
            case "Initialized" /* Initialized */:
                throw new Error(`All dependencies should be loading already before ` +
                    `pressureDependencyToExecute is called.`);
            default:
                const never = dependency;
                throw new Error(`Impossible module state: ${never.state}`);
        }
    }

    function whenModuleTerminated(module, onTerminalState) {
        switch (module.state) {
            case "Executed" /* Executed */:
            case "Failed" /* Failed */:
                onTerminalState();
                return;
            default:
                module.onNextStateChange.push(() => whenModuleTerminated(module, onTerminalState));
        }
    }

    /**
     * Return a module object from the registry for the given URL, creating one if
     * it doesn't exist yet.
     */
    function getModule(url, crossorigin = 'anonymous') {
        let mod = registry[url];
        if (mod === undefined) {
            mod = registry[url] = {
                url,
                urlBase: getUrlBase(url),
                exports: Object.create(null),
                state: "Initialized" /* Initialized */,
                stateData: undefined,
                isTopLevel: false,
                crossorigin,
                onNextStateChange: []
            };
        }
        return mod;
    }
    const anchor = document.createElement('a');
    /**
     * Use the browser to resolve a URL to its canonical format.
     *
     * Examples:
     *
     *  - /foo => http://example.com/foo
     *  - //example.com/ => http://example.com/
     *  - http://example.com => http://example.com/
     *  - http://example.com/foo/bar/../baz => http://example.com/foo/baz
     */
    function normalizeUrl(url) {
        anchor.href = url;
        return anchor.href;
    }
    /**
     * Examples:
     *
     *  - http://example.com/ => http://example.com/
     *  - http://example.com/foo.js => http://example.com/
     *  - http://example.com/foo/ => http://example.com/foo/
     *  - http://example.com/foo/?qu/ery#fr/ag => http://example.com/foo/
     */
    function getUrlBase(url) {
        url = url.split('?')[0];
        url = url.split('#')[0];
        // Normalization ensures we always have a trailing slash after a bare domain,
        // so this will always return with a trailing slash.
        return url.substring(0, url.lastIndexOf('/') + 1);
    }
    /**
     * Resolve a URL relative to a normalized base URL.
     */
    function resolveUrl(urlBase, url) {
        if (url.indexOf('://') !== -1) {
            // Already a fully qualified URL.
            return url;
        }
        return normalizeUrl(url[0] === '/' ? url : urlBase + url);
    }
    function getBaseUrl() {
        // IE does not have document.baseURI.
        return (document.baseURI ||
            (document.querySelector('base') || window.location).href);
    }
    /**
     * Get the url of the current document. If the document is the main document,
     * the base url is returned. Otherwise if the module was imported by a HTML
     * import we need to resolve the URL relative to the HTML import.
     *
     * document.currentScript does not work in IE11, but the HTML import polyfill
     * mocks it when executing an import so for this case that's ok
     */
    function getDocumentUrl() {
        const { currentScript } = document;
        // On IE11 document.currentScript is not defined when not in a HTML import
        if (!currentScript) {
            return baseUrl;
        }
        if (window.HTMLImports) {
            // When the HTMLImports polyfill is active, we can take the path from the
            // link element
            const htmlImport = window.HTMLImports.importForElement(currentScript);
            if (!htmlImport) {
                // If there is no import for the current script, we are in the index.html.
                // Take the base url.
                return baseUrl;
            }
            // Return the import href
            return htmlImport.href;
        }
        else {
            // On chrome's native implementation it's not possible to get a direct
            // reference to the link element, create an anchor and let the browser
            // resolve the url.
            const a = currentScript.ownerDocument.createElement('a');
            a.href = '';
            return a.href;
        }
    }



    /**
     * Define a module and execute its module body function when all dependencies
     * have executed.
     *
     * Dependencies must be specified as URLs, either relative or fully qualified
     * (e.g. "../foo.js" or "http://example.com/bar.js" but not "my-module-name").
     */
    window.define = function (deps, moduleBody) {
        // We don't yet know our own module URL. We need to discover it so that we
        // can resolve our relative dependency specifiers. There are two ways the
        // script executing this define() call could have been loaded:
        // Case #1: We are a dependency of another module. A <script> was injected
        // to load us, but we don't yet know the URL that was used. Because
        // document.currentScript is not supported by IE, we communicate the URL via
        // a global callback. When finished executing, the "onload" event will be
        // fired by this <script>, which will be handled by the loading script,
        // which will invoke the callback with our module object.
        let defined = false;
        pendingDefine = () => {
            defined = true;
            pendingDefine = undefined;
            return [deps, moduleBody];
        };
        // Case #2: We are a top-level script in the HTML document or a HTML import.
        // Resolve the URL relative to the document url. We can discover this case
        // by waiting a tick, and if we haven't already been defined by the "onload"
        // handler from case #1, then this must be case #2.
        const documentUrl = getDocumentUrl();
        // Save the value of the crossorigin attribute before setTimeout while we
        // can still get document.currentScript. If not set, default to 'anonymous'
        // to match native <script type="module"> behavior. Note: IE11 doesn't
        // support the crossorigin attribute nor currentScript, so it will use the
        // default.
        const crossorigin = document.currentScript &&
            document.currentScript.getAttribute('crossorigin') || 'anonymous';
        setTimeout(() => {
            if (defined === false) {
                pendingDefine = undefined;
                const url = documentUrl + '#' + topLevelScriptIdx++;
                // It's actually Initialized, but we're skipping over the Loading
                // state, because this is a top level document and it's already loaded.
                const mod = getModule(url, crossorigin);
                mod.isTopLevel = true;
                const waitingModule = beginWaitingForTurn(mod, deps, moduleBody);
                if (previousTopLevelUrl !== undefined) {
                    // type=module scripts execute in order (with the same timing as defer
                    // scripts). Because this is a top-level script, and we are trying to
                    // mirror type=module behavior as much as possible, wait for the
                    // previous module script to finish (successfully or otherwise)
                    // before executing further.
                    whenModuleTerminated(getModule(previousTopLevelUrl), () => {
                        beginWaitingOnDeps(waitingModule);
                    });
                }
                else {
                    beginWaitingOnDeps(waitingModule);
                }
                previousTopLevelUrl = url;
            }
        }, 0);
    };

})();
