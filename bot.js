const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('.'));

// Cargar configuración
let config = {};
try {
    config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
} catch (error) {
    console.log('Usando configuración por defecto');
    config = {
        salon: { nombre: "Salon María" },
        horario: { apertura: "09:00", cierre: "20:00", diasLaborables: [1,2,3,4,5,6] },
        peluqueros: [{ nombre: "María", especialidad: "Corte y Color" }],
        servicios: [{ nombre: "Corte", precio: 25, duracion: 30 }]
    };
}

// Base de datos simple
let citas = [];
let conversaciones = {};
let clienteWhatsApp = null;
let qrCodeData = '';
let estadoConexion = 'disconnected';

// ===============================
// CLIENTE WHATSAPP WEB
// ===============================
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './whatsapp-session'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// ===============================
// EVENTOS WHATSAPP
// ===============================
client.on('qr', (qr) => {
    console.log('📱 QR Code generado');
    qrcode.toDataURL(qr, (err, url) => {
        qrCodeData = url;
        estadoConexion = 'qr_ready';
        io.emit('qr', url);
    });
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado correctamente!');
    estadoConexion = 'connected';
    qrCodeData = '';
    io.emit('connected', true);
});

client.on('authenticated', () => {
    console.log('🔐 Autenticación exitosa');
    estadoConexion = 'authenticated';
});

client.on('auth_failure', () => {
    console.log('❌ Error de autenticación');
    estadoConexion = 'auth_failure';
    io.emit('auth_failure');
});

client.on('disconnected', (reason) => {
    console.log('📱 WhatsApp desconectado:', reason);
    estadoConexion = 'disconnected';
    io.emit('disconnected');
});

client.on('message', async (message) => {
    if (!message.fromMe && message.body) {
        const respuesta = procesarMensaje(message.body, message.from);
        if (respuesta) {
            await message.reply(respuesta);
        }
    }
});

// ===============================
// VERIFICAR HORARIO COMERCIAL
// ===============================
function estaAbierto() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const diaSemana = ahora.getDay();
    
    const horaActual = hora * 60 + minutos;
    const apertura = parseInt(config.horario.apertura.split(':')[0]) * 60 + parseInt(config.horario.apertura.split(':')[1]);
    const cierre = parseInt(config.horario.cierre.split(':')[0]) * 60 + parseInt(config.horario.cierre.split(':')[1]);
    
    return config.horario.diasLaborables.includes(diaSemana) && 
           horaActual >= apertura && 
           horaActual <= cierre;
}

// ===============================
// LÓGICA DEL BOT (IGUAL QUE ANTES)
// ===============================
function procesarMensaje(mensaje, telefono) {
    if (!estaAbierto()) {
        return `¡Hola! 🌙 ${config.salon.nombre} está cerrado ahora.\n\n🕐 Horario: ${config.horario.apertura} - ${config.horario.cierre}\n📅 ${config.horario.diasLaborables.map(d => ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]).join(', ')}\n\n¡Te atenderemos cuando abramos! 😊`;
    }

    const estado = conversaciones[telefono] || { paso: 'inicio' };
    const texto = mensaje.toLowerCase();

    switch (estado.paso) {
        case 'inicio':
            conversaciones[telefono] = { paso: 'servicio' };
            return `¡Hola! 😊 Soy Ana de ${config.salon.nombre} 💇‍♀️\n\n¿Qué servicio te gustaría reservar?\n\n${config.servicios.map((s, i) => `${i+1}. ${s.nombre} - ${s.precio}€ (${s.duracion}min)`).join('\n')}`;

        case 'servicio':
            const numServicio = parseInt(texto);
            if (numServicio >= 1 && numServicio <= config.servicios.length) {
                estado.servicio = config.servicios[numServicio - 1];
                estado.paso = 'peluquero';
                conversaciones[telefono] = estado;
                return `¡Perfecto! ✨ Has elegido ${estado.servicio.nombre}\n\n¿Con qué peluquero prefieres?\n\n${config.peluqueros.map((p, i) => `${i+1}. ${p.nombre} - ${p.especialidad}`).join('\n')}\n\nO escribe "cualquiera" si no tienes preferencia 😊`;
            }
            return 'Por favor, elige un número de la lista 😊';

        case 'peluquero':
            if (texto.includes('cualquier')) {
                estado.peluquero = config.peluqueros[0];
            } else {
                const numPeluquero = parseInt(texto);
                if (numPeluquero >= 1 && numPeluquero <= config.peluqueros.length) {
                    estado.peluquero = config.peluqueros[numPeluquero - 1];
                } else {
                    return 'Por favor, elige un número de la lista o escribe "cualquiera" 😊';
                }
            }
            estado.paso = 'fecha';
            conversaciones[telefono] = estado;
            return `¡Genial! Con ${estado.peluquero.nombre} 👏\n\n¿Para qué día y hora?\nEscribe: DD/MM/YYYY HH:MM\n\nEjemplo: 25/12/2024 15:30`;

        case 'fecha':
            if (texto.includes('/') && texto.includes(':')) {
                estado.fechaHora = texto;
                estado.paso = 'confirmar';
                conversaciones[telefono] = estado;
                return `🎯 ¡Perfecto! Resumen de tu cita:\n\n📅 ${estado.fechaHora}\n✂️ ${estado.servicio.nombre}\n👤 ${estado.peluquero.nombre}\n💰 ${estado.servicio.precio}€\n\n¿Confirmas esta cita? (Sí/No)`;
            }
            return 'Por favor, escribe la fecha y hora así: DD/MM/YYYY HH:MM\nEjemplo: 25/12/2024 15:30';

        case 'confirmar':
            if (texto.includes('si') || texto.includes('sí') || texto.includes('confirmar')) {
                const nuevaCita = {
                    id: Date.now(),
                    telefono: telefono,
                    fecha: estado.fechaHora,
                    servicio: estado.servicio.nombre,
                    peluquero: estado.peluquero.nombre,
                    precio: estado.servicio.precio,
                    confirmada: true,
                    fechaCreacion: new Date()
                };
                citas.push(nuevaCita);
                delete conversaciones[telefono];
                
                // Notificar al panel en tiempo real
                io.emit('nueva_cita', nuevaCita);
                
                return `🎉 ¡CITA CONFIRMADA!\n\nTe esperamos el ${estado.fechaHora} 😊\n\nTe enviaremos un recordatorio 24h antes 📱\n\n¡Gracias por confiar en ${config.salon.nombre}! 💕`;
            }
            
            if (texto.includes('no') || texto.includes('cancelar')) {
                delete conversaciones[telefono];
                return '😊 No hay problema. ¿Te gustaría elegir otra fecha y hora?\n\nEscribe "hola" para empezar de nuevo.';
            }
            
            return 'Por favor, responde "Sí" para confirmar o "No" para cancelar 😊';
    }
}

// ===============================
// RUTAS WEB
// ===============================
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/panel.html');
});

app.get('/api/estado', (req, res) => {
    res.json({
        estado: estadoConexion,
        abierto: estaAbierto(),
        citas: citas.length
    });
});

app.get('/api/qr', (req, res) => {
    res.json({ qr: qrCodeData });
});

app.get('/api/citas', (req, res) => {
    res.json(citas);
});

app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
    res.json({ success: true });
});

app.post('/api/reconectar', (req, res) => {
    if (estadoConexion !== 'connected') {
        client.initialize();
    }
    res.json({ success: true });
});

// ===============================
// SOCKET.IO PARA TIEMPO REAL
// ===============================
io.on('connection', (socket) => {
    console.log('🔌 Panel conectado');
    
    socket.emit('estado', {
        conexion: estadoConexion,
        abierto: estaAbierto(),
        citas: citas.length
    });
    
    if (qrCodeData) {
        socket.emit('qr', qrCodeData);
    }
});

// ===============================
// INICIAR SERVIDOR Y WHATSAPP
// ===============================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 Bot WhatsApp ejecutándose en puerto ${PORT}`);
    console.log(`📱 Panel: http://localhost:${PORT}`);
    console.log('📞 Iniciando WhatsApp Web...');
    
    // Inicializar WhatsApp Web
    client.initialize();
});

// Manejar cierre limpio
process.on('SIGINT', async () => {
    console.log('🛑 Cerrando bot...');
    await client.destroy();
    process.exit(0);
});
