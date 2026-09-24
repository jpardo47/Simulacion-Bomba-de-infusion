/* ============================================================================
 * ESCENA 3D DEL BANCO — Three.js
 * ----------------------------------------------------------------------------
 * Una unidad de Three.js = 1 mm. Geometría didáctica; las envolventes de los
 * componentes no sustituyen planos ni cotas verificadas de fabricante.
 *
 * Cambio estructural principal respecto a la versión 2D: el tramo de medida es
 * VERTICAL ASCENDENTE. Con D = 4 mm el número de Eötvös vale 2.18, por debajo
 * del umbral crítico de 3.37, de modo que el tapón de Taylor no asciende por
 * flotabilidad y viaja a la velocidad media del líquido — que es justo lo que
 * la ecuación Q = V·A necesita (auditoría P0-8).
 * ========================================================================== */

(function () {
  const Plant = SIM.Plant;
  const Path = Plant.Path;
  const U = SIM.util;
  const CFG = SIM.CFG;

  let renderer, scene, camera, raycaster, pointer;
  let seleccionables = [];
  let resaltado = null, seleccionado = null;
  const grupos = {};          // compId → THREE.Group

  /* --- Paleta ----------------------------------------------------------- */
  const COL = {
    aluminio: 0x9aa4ad,
    aluminioOsc: 0x5b646d,
    pcbAzul: 0x1558ae,
    pcbVerde: 0x11844c,
    negro: 0x14181d,
    plastico: 0x2b3440,
    vidrio: 0xcfe8f5,
    agua: 0x2899db,
    cobre: 0xb87333,
    silicona: 0xd8ddd6,
    cian: 0x38788e,
    ambar: 0xf59e0b,
    rojo: 0xef4444,
    verde: 0x10b981
  };

  const mat = {};
  function initMateriales() {
    mat.aluminio = new THREE.MeshStandardMaterial({ color: COL.aluminio, metalness: 0.45, roughness: 0.44 });
    mat.aluminioOsc = new THREE.MeshStandardMaterial({ color: COL.aluminioOsc, metalness: 0.4, roughness: 0.5 });
    mat.negro = new THREE.MeshStandardMaterial({ color: COL.negro, metalness: 0.25, roughness: 0.7 });
    mat.plastico = new THREE.MeshStandardMaterial({ color: COL.plastico, metalness: 0.05, roughness: 0.8 });
    mat.pcb = new THREE.MeshStandardMaterial({ color: COL.pcbAzul, metalness: 0.1, roughness: 0.65 });
    mat.pcbVerde = new THREE.MeshStandardMaterial({ color: COL.pcbVerde, metalness: 0.1, roughness: 0.65 });
    mat.cobre = new THREE.MeshStandardMaterial({ color: COL.cobre, metalness: 0.95, roughness: 0.3 });
    mat.silicona = new THREE.MeshStandardMaterial({
      color: COL.silicona, metalness: 0, roughness: 0.15,
      transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide
    });
    mat.agua = new THREE.MeshStandardMaterial({
      color: COL.agua, metalness: 0.1, roughness: 0.08,
      transparent: true, opacity: 0.28, depthWrite: false
    });
    mat.vidrio = new THREE.MeshStandardMaterial({
      color: COL.vidrio, metalness: 0, roughness: 0.05,
      transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide
    });
    mat.burbuja = new THREE.MeshStandardMaterial({
      color: 0xf59e0b, metalness: 0.0, roughness: 0.3,
      transparent: true, opacity: 0.95, emissive: 0x7a3900, emissiveIntensity: 0.25
    });
    mat.hazOn = new THREE.MeshBasicMaterial({ color: COL.cian, transparent: true, opacity: 0.85 });
    mat.hazOff = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.22 });
    mat.led = new THREE.MeshStandardMaterial({ color: 0x223, emissive: 0x000000 });
    mat.cable = {};
    ['#ef4444', '#111827', '#91600d', '#22d3ee', '#a78bfa', '#84cc16'].forEach(c => {
      mat.cable[c] = new THREE.MeshStandardMaterial({ color: new THREE.Color(c), metalness: 0.1, roughness: 0.6 });
    });
  }

  /* --- Utilidades de geometría ------------------------------------------ */
  function caja(w, h, d, material) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  }
  function cilindro(r, h, material, seg) {
    return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 24), material);
  }
  /** Cápsula (cilindro con casquetes) orientada según el eje Y. */
  function capsula(r, largo, material) {
    const g = new THREE.Group();
    const cuerpo = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(0.01, largo), 20), material);
    g.add(cuerpo);
    const capGeo = new THREE.SphereGeometry(r, 20, 12);
    const c1 = new THREE.Mesh(capGeo, material); c1.position.y = largo / 2;
    const c2 = new THREE.Mesh(capGeo, material); c2.position.y = -largo / 2;
    g.add(c1, c2);
    return g;
  }
  /** Etiqueta de texto como plano con textura de lienzo. */
  function etiqueta(texto, ancho, color) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const cx = cv.getContext('2d');
    cx.fillStyle = 'rgba(255,255,255,0.94)';
    cx.fillRect(0, 0, 512, 128);
    cx.strokeStyle = color || '#236a91';
    cx.lineWidth = 5; cx.strokeRect(2, 2, 508, 124);
    cx.fillStyle = color || '#236a91';
    cx.font = 'bold 54px Inter, Arial, sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(texto, 256, 68);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const h = ancho / 4;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ancho, h), m);
    mesh.userData.esEtiqueta = true;
    etiquetas.push(mesh);          // se orientan hacia la cámara cada fotograma
    return mesh;
  }
  const etiquetas = [];

  function registrar(id, grupo) {
    grupo.userData.compId = id;
    grupo.traverse(o => { if (o.isMesh && !o.userData.esEtiqueta) o.userData.compId = id; });
    grupos[id] = grupo;
    seleccionables.push(grupo);
    scene.add(grupo);
    return grupo;
  }

  /* ======================================================================
   * CONSTRUCCIÓN DE LOS COMPONENTES
   * ==================================================================== */

  function construirBase() {
    const g = new THREE.Group();
    // Placa base y perfilería del bastidor.
    const placa = caja(440, 8, 300, mat.aluminioOsc);
    placa.position.set(-10, -4, 0);
    placa.receiveShadow = true;
    g.add(placa);
    for (const x of [-220, 200]) {
      const perfil = caja(20, 20, 300, mat.aluminio);
      perfil.position.set(x, 10, 0);
      g.add(perfil);
    }
    // Bandeja de contención de derrames (auditoría §4.8).
    const bandeja = caja(430, 2, 290, new THREE.MeshStandardMaterial({
      color: 0xd6dcdf, metalness: 0.2, roughness: 0.9, transparent: true, opacity: 0.6
    }));
    bandeja.position.set(-10, 1, 0);
    g.add(bandeja);
    scene.add(g);
  }

  /** Raíl vertical de instrumentación: la pieza que fija la incertidumbre. */
  function construirRail() {
    const g = new THREE.Group();
    const perfil = caja(20, 260, 20, mat.aluminio);
    perfil.position.set(66, 130, 30);
    perfil.castShadow = true;
    g.add(perfil);
    // Ranura en T insinuada.
    const ranura = caja(3, 250, 12, mat.aluminioOsc);
    ranura.position.set(56, 130, 30);
    g.add(ranura);
    // Pie de anclaje.
    const pie = caja(50, 8, 50, mat.aluminio);
    pie.position.set(66, 4, 30);
    g.add(pie);

    const lbl = etiqueta('RAÍL 20×20', 62, '#526572');
    lbl.position.set(66, 268, 30);
    g.add(lbl);
    registrar('rail', g);
  }

  function construirTubo() {
    // Misma curva que usa la física: Catmull-Rom uniforme sobre los mismos
    // puntos de control, de modo que la coordenada `s` coincide en ambos.
    const curva = new THREE.CatmullRomCurve3(
      Plant.CONTROL_POINTS.map(p => new THREE.Vector3(p[0], p[1], p[2])),
      false, 'catmullrom', 0.5);
    curva.arcLengthDivisions = 2000;
    const SEGMENTOS = 600, RADIALES = 16;

    const g = new THREE.Group();

    // Pared del tubo (diámetro exterior).
    const paredGeo = new THREE.TubeGeometry(curva, SEGMENTOS, CFG.TUBO.D_EXT_MM / 2, RADIALES, false);
    const pared = new THREE.Mesh(paredGeo, mat.silicona);
    g.add(pared);

    // Columna de fluido (diámetro interior). El draw range permite mostrar
    // el llenado parcial durante el cebado, sin geometría adicional.
    const fluidoGeo = new THREE.TubeGeometry(curva, SEGMENTOS, Plant.st.dRealMm / 2, RADIALES, false);
    const fluido = new THREE.Mesh(fluidoGeo, mat.agua);
    fluido.userData.segmentos = SEGMENTOS;
    fluido.userData.radiales = RADIALES;
    fluido.userData.diametroMm = Plant.st.dRealMm;
    g.add(fluido);
    g.userData.fluido = fluido;

    // Abrazaderas de sujeción a lo largo del recorrido.
    for (let s = Plant.S_INYECCION + 30; s < Path.total; s += 85) {
      const p = Path.pointAt(s);
      const abr = new THREE.Mesh(new THREE.TorusGeometry(4.6, 1.1, 8, 20), mat.plastico);
      const t = Path.tangentAt(s);
      abr.position.set(p[0], p[1], p[2]);
      abr.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(t[0], t[1], t[2]));
      g.add(abr);
    }

    registrar('tube', g);
  }

  function construirBomba() {
    const g = new THREE.Group();
    const cx = -85, cy = 40, cz = 6;

    // Cabezal abierto para observar la compresión del tubo: soporte blanco,
    // pista fija, rotor de tres brazos y rodillos de polímero marfil.
    const blanco = new THREE.MeshStandardMaterial({ color: 0x2166b6, roughness: 0.65, metalness: 0.05 });
    const rodilloMat = new THREE.MeshStandardMaterial({ color: 0xe9dfc7, roughness: 0.4 });
    const fondo = cilindro(27, 5, blanco, 64);
    fondo.rotation.x = Math.PI / 2;
    fondo.position.set(cx, cy, cz - 9);
    g.add(fondo);
    const pista = new THREE.Mesh(new THREE.TorusGeometry(25, 2, 12, 64, Math.PI * 4 / 3), blanco);
    pista.rotation.z = -Math.PI / 6;
    pista.position.set(cx, cy, cz);
    g.add(pista);
    // El único tubo del cabezal es parte de CONTROL_POINTS, compartido con la planta.
    const rotor = new THREE.Group();
    const cubo = cilindro(5.5, 14, mat.aluminio, 24);
    cubo.rotation.x = Math.PI / 2;
    rotor.add(cubo);
    for (let i = 0; i < CFG.BOMBA.RODILLOS; i++) {
      const a = i * 2 * Math.PI / CFG.BOMBA.RODILLOS;
      const brazo = caja(CFG.BOMBA.RADIO_ROTOR_MM, 5, 3, mat.aluminio);
      brazo.position.set(Math.cos(a) * 7.5, Math.sin(a) * 7.5, -5);
      brazo.rotation.z = a;
      rotor.add(brazo);
      const rod = cilindro(4, 12, rodilloMat, 32);
      rod.rotation.x = Math.PI / 2;
      rod.position.set(Math.cos(a) * CFG.BOMBA.RADIO_ROTOR_MM, Math.sin(a) * CFG.BOMBA.RADIO_ROTOR_MM, 0);
      rotor.add(rod);
      const eje = cilindro(1.4, 14, mat.aluminioOsc, 16);
      eje.rotation.x = Math.PI / 2;
      eje.position.copy(rod.position);
      rotor.add(eje);
    }
    rotor.position.set(cx, cy, cz);
    g.add(rotor);
    g.userData.rotor = rotor;

    // Cuerpo del motor con su reductora.
    const motor = cilindro(13, 46, mat.aluminioOsc, 24);
    motor.rotation.x = Math.PI / 2;
    motor.position.set(cx, cy, cz - 38);
    g.add(motor);
    const reductora = caja(26, 26, 22, mat.negro);
    reductora.position.set(cx, cy, cz - 12);
    g.add(reductora);

    // Soportes antivibración de neopreno.
    for (const dx of [-18, 18]) for (const dz of [-30, 10]) {
      const pie = cilindro(5, 14, mat.negro, 14);
      pie.position.set(cx + dx, 9, cz + dz);
      g.add(pie);
    }
    const soporte = caja(48, 4, 58, mat.aluminio);
    soporte.position.set(cx, 18, cz - 10);
    g.add(soporte);
    const anclaje = caja(20, 14, 12, mat.aluminio);
    anclaje.position.set(cx, 27, cz - 14);
    g.add(anclaje);

    const lbl = etiqueta('PERISTÁLTICA', 82, '#236a91');
    lbl.position.set(cx, cy + 40, cz);
    g.add(lbl);

    registrar('pump', g);
  }

  function construirSensorOptico(id, sPos, texto) {
    const g = new THREE.Group();
    const p = Path.pointAt(sPos);

    // Emisor y receptor enfrentados a 180° a través del tubo.
    const sensorMat = new THREE.MeshStandardMaterial({ color: id === 's1' ? 0xd9454b : 0x169d65, roughness: 0.65 });
    const emisor = caja(11, 13, 7, sensorMat);
    emisor.position.set(p[0] - 9, p[1], p[2]);
    const receptor = caja(11, 13, 7, sensorMat);
    receptor.position.set(p[0] + 9, p[1], p[2]);
    g.add(emisor, receptor);

    // Haz infrarrojo con el ANCHO REAL de 1 mm (auditoría P1-2).
    const haz = new THREE.Mesh(
      new THREE.BoxGeometry(18, CFG.SENSOR_OPTICO.ANCHO_HAZ_MM, CFG.SENSOR_OPTICO.ANCHO_HAZ_MM),
      mat.hazOff.clone());
    haz.position.set(p[0], p[1], p[2]);
    g.add(haz);
    g.userData.haz = haz;

    // LED testigo del comparador.
    const led = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 10), mat.led.clone());
    led.position.set(p[0] - 9, p[1] + 8, p[2] + 4);
    g.add(led);
    g.userData.led = led;

    // Soporte al raíl.
    const brazo = caja(30, 6, 6, mat.aluminio);
    brazo.position.set(p[0] + 20, p[1], p[2]);
    g.add(brazo);

    const lbl = etiqueta(texto, 58, id === 's1' ? '#b72d38' : '#168054');
    lbl.position.set(p[0] - 34, p[1], p[2]);
    g.add(lbl);

    registrar(id, g);
  }

  function construirCotaSensores() {
    const g = new THREE.Group();
    const p1 = Path.pointAt(Plant.S_SENSOR_1);
    const p2 = Path.pointAt(Plant.S_SENSOR_2);
    const x = p1[0] - 26;
    const linea = caja(1, Math.abs(p2[1] - p1[1]), 1, new THREE.MeshBasicMaterial({ color: COL.cian }));
    linea.position.set(x, (p1[1] + p2[1]) / 2, p1[2]);
    g.add(linea);
    for (const p of [p1, p2]) {
      const t = caja(12, 1, 1, new THREE.MeshBasicMaterial({ color: COL.cian }));
      t.position.set(x + 5, p[1], p[2]);
      g.add(t);
    }
    const lbl = etiqueta(`d = ${Plant.D_REAL_SENSORES.toFixed(1)} mm`, 66, '#176b8c');
    lbl.position.set(x - 36, (p1[1] + p2[1]) / 2, p1[2]);
    g.add(lbl);
    scene.add(g);
  }

  function construirHall() {
    const g = new THREE.Group();
    const p = Path.pointAt(Plant.S_HALL);
    const cuerpo = caja(26, 40, 26, mat.plastico);
    cuerpo.position.set(p[0], p[1], p[2]);
    g.add(cuerpo);
    const rotor = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const asp = caja(2.2, 2.2, 16, mat.aluminio);
      asp.rotation.y = i * Math.PI / 2;
      asp.position.set(Math.sin(i * Math.PI / 2) * 6, 0, Math.cos(i * Math.PI / 2) * 6);
      rotor.add(asp);
    }
    rotor.position.set(p[0], p[1], p[2]);
    g.add(rotor);
    g.userData.rotor = rotor;
    const lbl = etiqueta('YF-S401', 54, '#facc15');
    lbl.position.set(p[0] - 36, p[1] + 26, p[2]);
    g.add(lbl);
    g.visible = false;
    registrar('hall', g);
  }

  function construirVaso(id, x, z, radio, alto, texto, color) {
    const g = new THREE.Group();
    const pared = new THREE.Mesh(
      new THREE.CylinderGeometry(radio, radio, alto, 32, 1, true), mat.vidrio);
    pared.position.set(x, alto / 2 + 4, z);
    g.add(pared);
    const fondo = new THREE.Mesh(new THREE.CircleGeometry(radio, 32), mat.vidrio);
    fondo.rotation.x = -Math.PI / 2;
    fondo.position.set(x, 4, z);
    g.add(fondo);
    // Graduaciones.
    for (let i = 1; i < 5; i++) {
      const anillo = new THREE.Mesh(new THREE.TorusGeometry(radio, 0.35, 6, 32),
        new THREE.MeshBasicMaterial({ color: 0x70889b, transparent: true, opacity: 0.6 }));
      anillo.rotation.x = Math.PI / 2;
      anillo.position.set(x, 4 + alto * i / 5, z);
      g.add(anillo);
    }
    // Columna de líquido, con altura variable.
    const liq = cilindro(radio - 1.2, 1, mat.agua.clone(), 32);
    liq.material.opacity = 0.48;
    liq.position.set(x, 5, z);
    g.add(liq);
    g.userData.liquido = liq;
    g.userData.radio = radio;
    g.userData.alto = alto;
    g.userData.baseY = 4;

    const lbl = etiqueta(texto, 72, color || '#236a91');
    lbl.position.set(x, alto + 22, z);
    g.add(lbl);
    if (id === 'beakerOut') g.position.y = 30; // vaso apoyado sobre el plato, no dentro de la balanza
    registrar(id, g);
  }

  function construirBalanza() {
    const g = new THREE.Group();
    const x = 140, z = -18;
    const cuerpo = caja(150, 26, 150, new THREE.MeshStandardMaterial({ color: 0x65519c, roughness: 0.65 }));
    cuerpo.position.set(x, 13, z);
    cuerpo.castShadow = true;
    g.add(cuerpo);
    const plato = new THREE.Mesh(new THREE.CylinderGeometry(62, 62, 3, 40), mat.aluminio);
    plato.position.set(x, 27, z);
    g.add(plato);
    // Pantalla LCD con textura de lienzo, refrescada desde la física.
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const tex = new THREE.CanvasTexture(cv);
    const lcd = new THREE.Mesh(new THREE.PlaneGeometry(58, 15),
      new THREE.MeshBasicMaterial({ map: tex }));
    lcd.position.set(x, 16, z + 75.2);
    g.add(lcd);
    g.userData.lcd = { canvas: cv, tex };
    const lbl = etiqueta('BALANZA 0.01 g', 78, '#347151');
    lbl.position.set(x, 58, z - 80);
    g.add(lbl);
    registrar('scale', g);
  }

  function construirPesajeOrigen() {
    const g = new THREE.Group();
    const celda = caja(47, 6, 12, mat.aluminio);
    celda.position.set(-150, 5, -30); g.add(celda);
    const plato = cilindro(43, 3, mat.aluminio, 32);
    plato.position.set(-150, 9, -30); g.add(plato);
    const lbl = etiqueta('CELDA 500 g', 70, '#b72d38');
    lbl.position.set(-196, 24, 12); g.add(lbl);
    registrar('loadcell', g);
    const h = new THREE.Group();
    const pcb = caja(34, 3, 22, mat.pcbVerde); pcb.position.set(-197, 14, -74); h.add(pcb);
    const chip = caja(12, 3, 8, mat.negro); chip.position.set(-197, 17, -74); h.add(chip);
    const texto = etiqueta('HX711 · PESO', 72, '#168054'); texto.position.set(-197, 37, -74); h.add(texto);
    registrar('hx711', h);
    construirCable([[-150,5,-30],[-176,10,-48],[-197,16,-74]], '#ef4444');
    construirCable([[-197,16,-74],[-170,20,-88],[-140,18,-101]], '#111827');
  }

  function construirElectronica() {
    // --- Arduino Nano ---
    const gN = new THREE.Group();
    const nx = -150, ny = 14, nz = -110;
    const pcb = caja(45, 1.6, 18, mat.pcb);
    pcb.position.set(nx, ny, nz);
    gN.add(pcb);
    const chip = caja(9, 1.6, 9, mat.negro);
    chip.position.set(nx, ny + 1.6, nz);
    gN.add(chip);
    const usb = caja(8, 3.2, 7, mat.aluminio);
    usb.position.set(nx - 20, ny + 2, nz);
    gN.add(usb);
    for (let i = 0; i < 15; i++) {
      for (const dz of [-9.5, 9.5]) {
        const pin = caja(0.8, 3, 0.8, mat.cobre);
        pin.position.set(nx - 21 + i * 3, ny - 1.5, nz + dz);
        gN.add(pin);
      }
    }
    const lblN = etiqueta('ARDUINO NANO', 74, '#22d3ee');
    lblN.position.set(nx, ny + 26, nz);
    gN.add(lblN);
    registrar('mcu', gN);

    // --- Módulo L298N ---
    const gD = new THREE.Group();
    const dx = -60, dy = 14, dz = -110;
    const pcbD = caja(43, 1.6, 43, mat.pcbVerde);
    pcbD.position.set(dx, dy, dz);
    gD.add(pcbD);
    // Disipador con aletas.
    for (let i = 0; i < 7; i++) {
      const aleta = caja(1.6, 22, 24, mat.aluminio);
      aleta.position.set(dx - 9 + i * 3, dy + 12, dz);
      gD.add(aleta);
    }
    const ic = caja(6, 16, 20, mat.negro);
    ic.position.set(dx + 4, dy + 9, dz);
    gD.add(ic);
    // Borneras de tornillo.
    for (const [bx, bz] of [[-14, 18], [0, 18], [14, 18], [-14, -18], [14, -18]]) {
      const b = caja(9, 8, 8, new THREE.MeshStandardMaterial({ color: 0x1e40af, roughness: 0.7 }));
      b.position.set(dx + bx, dy + 5, dz + bz);
      gD.add(b);
    }
    const lblD = etiqueta('DRIVER L298N', 74, '#60a5fa');
    lblD.position.set(dx, dy + 40, dz);
    gD.add(lblD);
    registrar('driver', gD);

    // --- Fuente conmutada ---
    const gP = new THREE.Group();
    const px = 20, py = 14, pz = -110;
    const cuerpo = caja(60, 30, 40, mat.aluminioOsc);
    cuerpo.position.set(px, py + 14, pz);
    gP.add(cuerpo);
    const lblP = etiqueta('FUENTE 12 V 2 A', 76, '#91600d');
    lblP.position.set(px, py + 42, pz);
    gP.add(lblP);
    registrar('psu', gP);

    // --- Cableado entre pines reales ---
    construirCable([[-129, 15, -105], [-100, 30, -110], [-78, 16, -92]], '#22d3ee'); // D9 → ENA
    construirCable([[-129, 15, -100], [-104, 26, -112], [-78, 16, -100]], '#a78bfa'); // D8 → IN1
    construirCable([[-129, 15, -95], [-108, 22, -114], [-78, 16, -108]], '#84cc16');  // D7 → IN2
    construirCable([[-10, 22, -95], [-30, 26, -100], [-46, 16, -92]], '#ef4444');     // +12 V
    construirCable([[-10, 22, -100], [-34, 20, -106], [-46, 16, -100]], '#111827');   // GND
  }

  function construirCable(puntos, color) {
    const pts = puntos.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const curva = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curva, 40, 1.1, 8, false);
    const m = mat.cable[color] || mat.cable['#111827'];
    scene.add(new THREE.Mesh(geo, m));
  }

  function construirYPort() {
    const g = new THREE.Group();
    const p = Path.pointAt(Plant.S_INYECCION);
    const cuerpo = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 20, 16), mat.plastico);
    const t = Path.tangentAt(Plant.S_INYECCION);
    cuerpo.position.set(p[0], p[1], p[2]);
    cuerpo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(t[0], t[1], t[2]));
    g.add(cuerpo);
    // Rama de inyección con jeringa.
    const rama = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 22, 14), mat.plastico);
    rama.position.set(p[0], p[1] + 12, p[2]);
    rama.rotation.z = 0.5;
    g.add(rama);
    const jeringa = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 34, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, roughness: 0.1 }));
    jeringa.position.set(p[0] + 9, p[1] + 34, p[2]);
    jeringa.rotation.z = 0.5;
    g.add(jeringa);
    const embolo = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 6, 14),
      new THREE.MeshStandardMaterial({ color: COL.ambar }));
    embolo.position.set(p[0] + 14, p[1] + 46, p[2]);
    embolo.rotation.z = 0.5;
    g.add(embolo);
    const lbl = etiqueta('PUERTO EN Y', 66, '#91600d');
    lbl.position.set(p[0] - 6, p[1] + 62, p[2]);
    g.add(lbl);
    registrar('yport', g);
  }

  function construirValvula() {
    const g = new THREE.Group();
    const s = Path.total - 40;
    const p = Path.pointAt(s), t = Path.tangentAt(s);
    const cuerpo = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 26, 16), mat.plastico);
    cuerpo.position.set(p[0], p[1], p[2]);
    cuerpo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(t[0], t[1], t[2]));
    g.add(cuerpo);
    registrar('checkvalve', g);
  }

  /* ======================================================================
   * TRAZADORES: mallas creadas y destruidas con las burbujas
   * ==================================================================== */
  const mallasTrazador = new Map();
  let grupoTrazadores;
  const marcasFlujo = [];
  let gotaSalida;

  function construirIndicadoresFlujo() {
    // Marcas didácticas: no son burbujas ni generan señales en los sensores.
    const geo = new THREE.SphereGeometry(1.45, 10, 8);
    const color = new THREE.MeshBasicMaterial({ color: 0x0879d6 });
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(geo, color);
      scene.add(m); marcasFlujo.push(m);
    }
    gotaSalida = new THREE.Mesh(new THREE.SphereGeometry(2.1, 14, 10), color);
    scene.add(gotaSalida);
  }

  function actualizarIndicadoresFlujo() {
    const st = Plant.st;
    marcasFlujo.forEach((m, i) => {
      const s = (st.recorridoFlujoMm + i * Path.total / marcasFlujo.length) % Path.total;
      const p = Path.pointAt(s);
      m.position.set(p[0], p[1], p[2]);
      m.visible = s <= st.frenteS;
    });
    if (gotaSalida) {
      // Una gota ilustrativa por 0.04 mL; la balanza usa el volumen integrado,
      // nunca el tamaño ni el recuento de estos dibujos.
      const fase = (st.desplazadoMl / 0.04) % 1;
      const nivel = 34 + Math.min(90, st.liquidoEntregadoMl / 250 * 95);
      gotaSalida.position.set(140, 136 - fase * (136 - nivel), -18);
      gotaSalida.visible = st.caudalColectorMlS > 0.00001;
    }
  }

  function actualizarTrazadores() {
    const vivos = new Set();
    for (const tr of Plant.st.trazadores) {
      vivos.add(tr.id);
      let m = mallasTrazador.get(tr.id);
      if (!m) {
        m = capsula(Plant.st.dRealMm / 2 * 0.97,
          Math.max(0.1, tr.longitudMm - Plant.st.dRealMm), mat.burbuja);
        grupoTrazadores.add(m);
        mallasTrazador.set(tr.id, m);
      }
      const sMedio = tr.s - tr.longitudMm / 2;
      const p = Path.pointAt(sMedio);
      const t = Path.tangentAt(sMedio);
      m.position.set(p[0], p[1], p[2]);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(t[0], t[1], t[2]));
    }
    for (const [id, m] of mallasTrazador) {
      if (!vivos.has(id)) {
        grupoTrazadores.remove(m);
        m.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
        mallasTrazador.delete(id);
      }
    }
  }

  /* ======================================================================
   * ORBITACIÓN DE CÁMARA (implementación propia, sin dependencias)
   * ==================================================================== */
  function crearOrbita(cam, dom, objetivo) {
    const est = {
      objetivo: objetivo.clone(),
      radio: 650 * Math.max(1, 1 / cam.aspect), theta: -0.42, phi: 1.12,
      arrastrando: false, desplazando: false, px: 0, py: 0
    };
    function aplicar() {
      const s = Math.sin(est.phi), c = Math.cos(est.phi);
      cam.position.set(
        est.objetivo.x + est.radio * s * Math.sin(est.theta),
        est.objetivo.y + est.radio * c,
        est.objetivo.z + est.radio * s * Math.cos(est.theta)
      );
      cam.lookAt(est.objetivo);
    }
    dom.addEventListener('pointerdown', e => {
      est.arrastrando = true;
      est.desplazando = e.button === 2 || e.shiftKey;
      est.px = e.clientX; est.py = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', e => {
      est.arrastrando = false;
      try { dom.releasePointerCapture(e.pointerId); } catch (_) { }
    });
    dom.addEventListener('pointermove', e => {
      if (!est.arrastrando) return;
      const dx = e.clientX - est.px, dy = e.clientY - est.py;
      est.px = e.clientX; est.py = e.clientY;
      if (est.desplazando) {
        est.objetivo.x -= dx * est.radio * 0.0016 * Math.cos(est.theta);
        est.objetivo.z += dx * est.radio * 0.0016 * Math.sin(est.theta);
        est.objetivo.y += dy * est.radio * 0.0016;
      } else {
        est.theta -= dx * 0.006;
        est.phi = U.clamp(est.phi - dy * 0.006, 0.12, Math.PI - 0.12);
      }
      aplicar();
    });
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      est.radio = U.clamp(est.radio * (1 + Math.sign(e.deltaY) * 0.1), 90, 1400);
      aplicar();
    }, { passive: false });
    dom.addEventListener('contextmenu', e => e.preventDefault());
    aplicar();
    return { est, aplicar };
  }

  let orbita;

  /* ======================================================================
   * SELECCIÓN POR RAYCASTING
   * El inspector SOLO se monta al hacer clic (auditoría §5.5).
   * ==================================================================== */
  function grupoDe(obj) {
    let o = obj;
    while (o && !o.userData.compId) o = o.parent;
    return o && grupos[o.userData.compId] ? grupos[o.userData.compId] : null;
  }

  /* Resaltado por contorno de caja. No se tocan los materiales: son
   * compartidos entre componentes y mutarlos resaltaría medio banco. */
  let cajaHover = null, cajaSel = null;

  function resaltar(grupo, cual, color) {
    const actual = cual === 'sel' ? cajaSel : cajaHover;
    if (actual) { scene.remove(actual); actual.geometry.dispose(); }
    let nueva = null;
    if (grupo) {
      nueva = new THREE.BoxHelper(grupo, color);
      nueva.material.depthTest = false;
      nueva.material.transparent = true;
      nueva.material.opacity = cual === 'sel' ? 0.95 : 0.55;
      nueva.renderOrder = 999;
      scene.add(nueva);
    }
    if (cual === 'sel') cajaSel = nueva; else cajaHover = nueva;
  }

  function intersecar(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(seleccionables, true);
    for (const h of hits) {
      if (h.object.userData.esEtiqueta) continue;
      const g = grupoDe(h.object);
      if (g && g.visible) return g;
    }
    return null;
  }

  function onHover(ev) {
    const g = intersecar(ev);
    if (g === resaltado) return;
    resaltado = g;
    resaltar(g && g !== seleccionado ? g : null, 'hover', 0x658fa5);
    renderer.domElement.style.cursor = g ? 'pointer' : 'grab';
  }

  let arrastroDesde = null;
  function onDown(ev) { arrastroDesde = { x: ev.clientX, y: ev.clientY }; }
  function onUp(ev) {
    if (!arrastroDesde) return;
    const movido = Math.hypot(ev.clientX - arrastroDesde.x, ev.clientY - arrastroDesde.y);
    arrastroDesde = null;
    if (movido > 5) return;                 // fue una rotación de cámara, no un clic
    const g = intersecar(ev);
    if (!g) { seleccionar(null); return; }
    seleccionar(g.userData.compId);
  }

  function seleccionar(compId) {
    seleccionado = compId ? grupos[compId] : null;
    resaltar(seleccionado, 'sel', 0x236a91);
    resaltar(null, 'hover');
    if (seleccionado) SIM.Inspector.abrir(compId, seleccionado);
    else SIM.Inspector.cerrar();
  }

  /* ======================================================================
   * ACTUALIZACIÓN POR FOTOGRAMA
   * ==================================================================== */
  function actualizar() {
    const st = Plant.st;

    // Rotor peristáltico: gira a la velocidad que dicta la física, y el
    // caudal nace de esa rotación, no al revés.
    if (grupos.pump && grupos.pump.userData.rotor) {
      grupos.pump.userData.rotor.rotation.z = -st.anguloBomba;
    }
    if (grupos.hall && grupos.hall.userData.rotor) {
      grupos.hall.userData.rotor.rotation.y += SIM.Hardware.hall.rpm * 0.10472 * 0.016;
    }

    // Llenado del tubo durante el cebado.
    const gT = grupos.tube;
    if (gT && gT.userData.fluido) {
      const f = gT.userData.fluido;
      if (f.userData.diametroMm !== st.dRealMm) {
        const curva = new THREE.CatmullRomCurve3(
          Plant.CONTROL_POINTS.map(p => new THREE.Vector3(...p)), false, 'catmullrom', 0.5);
        curva.arcLengthDivisions = 2000;
        f.geometry.dispose();
        f.geometry = new THREE.TubeGeometry(curva, f.userData.segmentos, st.dRealMm / 2, f.userData.radiales, false);
        f.userData.diametroMm = st.dRealMm;
      }
      const frac = U.clamp(st.frenteS / Path.total, 0, 1);
      const segs = f.userData.segmentos, rad = f.userData.radiales;
      const porSeg = rad * 6;
      f.geometry.setDrawRange(0, Math.floor(frac * segs) * porSeg);
    }

    // Sensores ópticos: haz y LED testigo.
    const hw = SIM.Hardware;
    for (const [id, clave] of [['s1', 's1'], ['s2', 's2']]) {
      const g = grupos[id];
      if (!g) continue;
      const obstruido = hw.obstruccion[clave] > 0.25;
      if (g.userData.haz) {
        g.userData.haz.material.color.setHex(obstruido ? 0x00f2fe : 0xef4444);
        g.userData.haz.material.opacity = obstruido ? 0.95 : 0.2;
      }
      if (g.userData.led) {
        g.userData.led.material.emissive.setHex(obstruido ? 0x00f2fe : 0x000000);
        g.userData.led.material.color.setHex(obstruido ? 0x00f2fe : 0x223344);
      }
    }

    // Visibilidad según el sensor seleccionado.
    const optico = SIM.Firmware.st.sensor === 'optico';
    if (grupos.s1) grupos.s1.visible = optico;
    if (grupos.s2) grupos.s2.visible = optico;
    if (grupos.hall) grupos.hall.visible = !optico;

    // Niveles de líquido en los vasos.
    actualizarVaso('beakerIn', st.depositoMl, 500);
    actualizarVaso('beakerOut', st.liquidoEntregadoMl, 250);

    // Pantalla de la balanza.
    const gB = grupos.scale;
    if (gB && gB.userData.lcd) {
      const { canvas, tex } = gB.userData.lcd;
      const cx = canvas.getContext('2d');
      cx.fillStyle = '#dce6d8'; cx.fillRect(0, 0, 256, 64);
      cx.fillStyle = '#347151';
      cx.font = 'bold 34px JetBrains Mono, monospace';
      cx.textAlign = 'right'; cx.textBaseline = 'middle';
      cx.fillText(`${st.masaIndicadaG.toFixed(2)} g`, 240, 34);
      tex.needsUpdate = true;
    }

    actualizarTrazadores();
    actualizarIndicadoresFlujo();

    // Las etiquetas son carteles planos: se orientan hacia la cámara.
    for (let i = 0; i < etiquetas.length; i++) etiquetas[i].quaternion.copy(camera.quaternion);

    // Los contornos de selección siguen al componente si éste se mueve.
    if (cajaSel) cajaSel.update();
    if (cajaHover) cajaHover.update();

    renderer.render(scene, camera);
  }

  function actualizarVaso(id, ml, capacidadMl) {
    const g = grupos[id];
    if (!g || !g.userData.liquido) return;
    const h = U.clamp(ml / capacidadMl, 0, 1) * (g.userData.alto - 6);
    const liq = g.userData.liquido;
    liq.scale.y = Math.max(0.01, h);
    liq.position.y = g.userData.baseY + h / 2;
  }

  /* ======================================================================
   * ARRANQUE
   * ==================================================================== */
  function init(contenedor) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(contenedor.clientWidth, contenedor.clientHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    contenedor.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    camera = new THREE.PerspectiveCamera(42, contenedor.clientWidth / contenedor.clientHeight, 1, 4000);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9bdc1, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(240, 420, 320);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -350; key.shadow.camera.right = 350;
    key.shadow.camera.top = 400; key.shadow.camera.bottom = -50;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.65);
    fill.position.set(-300, 200, -240);
    scene.add(fill);
    const rim = new THREE.PointLight(0xffffff, 0.25, 600);
    rim.position.set(60, 240, 120);
    scene.add(rim);

    initMateriales();
    grupoTrazadores = new THREE.Group();
    scene.add(grupoTrazadores);

    construirBase();
    construirRail();
    construirBomba();
    construirTubo();
    construirIndicadoresFlujo();
    construirValvula();
    construirVaso('beakerIn', -150, -30, 40, 110, 'DEPÓSITO PESADO', '#236a91');
    grupos.beakerIn.position.y = 10;
    construirPesajeOrigen();
    construirVaso('beakerOut', 140, -18, 35, 95, 'COLECTOR', '#347151');
    construirBalanza();
    construirElectronica();

    // Los valores RGB elegidos son sRGB. Convertir una vez cada material
    // evita el aspecto pastel al usar salida sRGB con iluminación lineal.
    const convertidos = new Set();
    scene.traverse(o => {
      if (!o.isMesh) return;
      for (const material of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!material || convertidos.has(material)) continue;
        if (material.color) material.color.convertSRGBToLinear();
        convertidos.add(material);
      }
    });

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    orbita = crearOrbita(camera, renderer.domElement, new THREE.Vector3(0, 110, 0));

    renderer.domElement.addEventListener('pointermove', onHover);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.style.cursor = 'grab';

    window.addEventListener('resize', () => {
      const w = contenedor.clientWidth, h = contenedor.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (!seleccionado) encuadrar(null);
    });
  }

  function encuadrar(compId) {
    if (!orbita) return;
    const g = compId ? grupos[compId] : null;
    if (!g) {
      orbita.est.objetivo.set(0, 110, 0);
      orbita.est.radio = 650 * Math.max(1, 1 / camera.aspect);
      orbita.est.theta = -0.42; orbita.est.phi = 1.12;
    } else {
      const box = new THREE.Box3().setFromObject(g);
      const c = box.getCenter(new THREE.Vector3());
      orbita.est.objetivo.copy(c);
      orbita.est.radio = Math.max(90, box.getSize(new THREE.Vector3()).length() * 2.6);
    }
    orbita.aplicar();
  }

  SIM.Scene3D = {
    init, actualizar, seleccionar, encuadrar,
    grupos, get materiales() { return mat; },
    get seleccionado() { return seleccionado ? seleccionado.userData.compId : null; },
    listaComponentes() { return Object.keys(grupos); }
  };
})();
