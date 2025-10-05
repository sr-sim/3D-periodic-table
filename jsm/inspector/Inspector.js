
import { RendererInspector } from './RendererInspector.js';
import { Profiler } from './ui/Profiler.js';
import { Performance } from './tabs/Performance.js';
import { Console } from './tabs/Console.js';
import { Parameters } from './tabs/Parameters.js';
import { Viewer } from './tabs/Viewer.js';
import { setText, ease, splitPath, splitCamelCase } from './ui/utils.js';

import { QuadMesh, NodeMaterial, CanvasTarget, setConsoleFunction, REVISION, NoToneMapping } from 'three/webgpu';
import { renderOutput, vec3, vec4 } from 'three/tsl';

const EASE_FACTOR = 0.1;

class Inspector extends RendererInspector {

	constructor() {

		super();

		// init profiler

		const profiler = new Profiler();

		const parameters = new Parameters();
		parameters.hide();
		profiler.addTab( parameters );

		const viewer = new Viewer();
		viewer.hide();
		profiler.addTab( viewer );

		const performance = new Performance();
		profiler.addTab( performance );

		const console = new Console();
		profiler.addTab( console );

		profiler.setActiveTab( performance.id );

		//

		this.deltaTime = 0;
		this.softDeltaTime = 0;

		this.statsData = new Map();
		this.canvasNodes = new Map();
		this.profiler = profiler;
		this.performance = performance;
		this.console = console;
		this.parameters = parameters;
		this.viewer = viewer;
		this.once = {};

		this.displayCycle = {
			text: {
				needsUpdate: false,
				duration: .25,
				time: 0
			},
			graph: {
				needsUpdate: false,
				duration: .05,
				time: 0
			}
		};

	}

	get domElement() {

		return this.profiler.domElement;

	}

	computeAsync() {

		const renderer = this.getRenderer();
		const animationLoop = renderer.getAnimationLoop();

		if ( renderer.info.frame > 1 && animationLoop !== null ) {

			this.resolveConsoleOnce( 'log', 'TIP: "computeAsync()" was called while a "setAnimationLoop()" is active. This is probably not necessary, use "compute()" instead.' );

		}

	}

	resolveConsoleOnce( type, message ) {

		const key = type + message;

		if ( this.once[ key ] !== true ) {

			this.resolveConsole( type, message );
			this.once[ key ] = true;

		}

	}

	resolveConsole( type, message ) {

		switch ( type ) {

			case 'log':

				this.console.addMessage( 'info', message );

				console.log( message );

				break;

			case 'warn':

				this.console.addMessage( 'warn', message );

				console.warn( message );

				break;

			case 'error':

				this.console.addMessage( 'error', message );

				console.error( message );

				break;

		}

	}

	init() {

		const renderer = this.getRenderer();

		let sign = `THREE.WebGPURenderer: ${ REVISION } [ "`;

		if ( renderer.backend.isWebGPUBackend ) {

			sign += 'WebGPU';

		} else if ( renderer.backend.isWebGLBackend ) {

			sign += 'WebGL2';

		}

		sign += '" ]';

		this.console.addMessage( 'info', sign );

		//

		if ( renderer.inspector.domElement.parentElement === null && renderer.domElement.parentElement !== null ) {

			renderer.domElement.parentElement.appendChild( renderer.inspector.domElement );

		}

	}

	setRenderer( renderer ) {

		super.setRenderer( renderer );

		if ( renderer !== null ) {

			setConsoleFunction( this.resolveConsole.bind( this ) );

			if ( this.isAvailable ) {

				renderer.backend.trackTimestamp = true;

				renderer.hasFeatureAsync( 'timestamp-query' ).then( ( available ) => {

					if ( available !== true ) {

						this.console.addMessage( 'error', 'THREE.Inspector: GPU Timestamp Queries not available.' );

					}

				} );

			}

		}

		return this;

	}

	createParameters( name ) {

		if ( this.parameters.isVisible === false ) {

			this.parameters.show();
			this.profiler.setActiveTab( this.parameters.id );

		}

		return this.parameters.createGroup( name );

	}

	getStatsData( cid ) {

		let data = this.statsData.get( cid );

		if ( data === undefined ) {

			data = {};

			this.statsData.set( cid, data );

		}

		return data;

	}

	resolveStats( stats ) {

		const data = this.getStatsData( stats.cid );

		if ( data.initialized !== true ) {

			data.cpu = stats.cpu;
			data.gpu = stats.gpu;

			data.initialized = true;

		}

		// TODO: Smooth values

		data.cpu = stats.cpu; // ease( .. )
		data.gpu = stats.gpu;
		data.total = data.cpu + data.gpu;

		//

		for ( const child of stats.children ) {

			this.resolveStats( child );

			const childData = this.getStatsData( child.cid );

			data.cpu += childData.cpu;
			data.gpu += childData.gpu;
			data.total += childData.total;

		}

	}

	getCanvasDataByNode( node ) {

		let canvasData = this.canvasNodes.get( node );

		if ( canvasData === undefined ) {

			const renderer = this.getRenderer();

			const canvas = document.createElement( 'canvas' );

			const canvasTarget = new CanvasTarget( canvas );
			canvasTarget.setPixelRatio( window.devicePixelRatio );
			canvasTarget.setSize( 140, 140 );

			const id = node.id;

			const { path, name } = splitPath( splitCamelCase( node.getName() || '(unnamed)' ) );

			let output = vec4( vec3( node ), 1 );
			output = renderOutput( output, NoToneMapping, renderer.outputColorSpace );
			output = output.context( { inspector: true } );

			const material = new NodeMaterial();
			material.outputNode = output;

			const quad = new QuadMesh( material );
			quad.name = 'Viewer - ' + name;

			canvasData = {
				id,
				name,
				path,
				node,
				quad,
				canvasTarget,
				material
			};

			this.canvasNodes.set( node, canvasData );

		}

		return canvasData;

	}

	resolveViewer() {

		const nodes = this.currentNodes;
		const renderer = this.getRenderer();

		if ( nodes.length === 0 ) return;

		if ( ! renderer.backend.isWebGPUBackend ) {

			this.resolveConsoleOnce( 'warn', 'Inspector: Viewer is only available with WebGPU.' );

			return;

		}

		//

		if ( ! this.viewer.isVisible ) {

			this.viewer.show();

		}

		const canvasDataList = nodes.map( node => this.getCanvasDataByNode( node ) );

		this.viewer.update( renderer, canvasDataList );

	}

	resolveFrame( frame ) {

		const nextFrame = this.getFrameById( frame.frameId + 1 );

		if ( ! nextFrame ) return;

		frame.cpu = 0;
		frame.gpu = 0;
		frame.total = 0;

		for ( const stats of frame.children ) {

			this.resolveStats( stats );

			const data = this.getStatsData( stats.cid );

			frame.cpu += data.cpu;
			frame.gpu += data.gpu;
			frame.total += data.total;

		}

		// improve stats using next frame

		frame.deltaTime = nextFrame.startTime - frame.startTime;
		frame.miscellaneous = frame.deltaTime - frame.total;

		if ( frame.miscellaneous < 0 ) {

			// Frame desync, probably due to async GPU timing.

			frame.miscellaneous = 0;

		}

		//

		if ( this.softDeltaTime === 0 ) {

			this.softDeltaTime = frame.deltaTime;

		}

		this.deltaTime = frame.deltaTime;
		this.softDeltaTime = ease( this.softDeltaTime, frame.deltaTime, this.nodeFrame.deltaTime, EASE_FACTOR );

		this.updateCycle( this.displayCycle.text );
		this.updateCycle( this.displayCycle.graph );

		if ( this.displayCycle.text.needsUpdate ) {

			setText( 'fps-counter', this.softFPS.toFixed() );

			this.performance.updateText( this, frame );

		}

		if ( this.displayCycle.graph.needsUpdate ) {

			this.performance.updateGraph( this, frame );

		}

		this.displayCycle.text.needsUpdate = false;
		this.displayCycle.graph.needsUpdate = false;

	}

	get fps() {

		return 1000 / this.deltaTime;

	}

	get softFPS() {

		return 1000 / this.softDeltaTime;

	}

	updateCycle( cycle ) {

		cycle.time += this.nodeFrame.deltaTime;

		if ( cycle.time >= cycle.duration ) {

			cycle.needsUpdate = true;
			cycle.time = 0;

		}

	}

}

export { Inspector };
