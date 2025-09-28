const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');

// Cargar configuración
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const app = express();

app.use(bodyParser.json());
app.use(express.static('.'));

// Base de datos simple en memoria
let citas = [];
let conversaciones = {};

// ===============================
// VERIFICAR HORARIO COMERCIAL
// ===============================
function estaAbierto() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const diaSemana = ahora.getDay(); // 0=domingo, 1=lunes...
    
    const horaActual = hora * 60 + minutos;
    const apertura = parseInt(config.horario.apertura.split(':')[0]) * 60 + parseInt(config.horario.apertura.split(':')[1]);
    const cierre = parseInt(config.horario.cierre.split(':')[0]) * 60 + parseInt(config.horario.cierre.split(':')[1]);
    
    return config.horario.diasLaborables.includes(diaSemana) && 
           horaActual >= apertura && 
           horaActual <= cierre;
}

// ===============================
// LÓGICA DEL BOT
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
                    confirmada: true
                };
                citas.push(nuevaCita);
                delete conversaciones[telefono];
                
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
// WEBHOOK WHATSAPP
// ===============================
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = config.whatsapp.verifyToken;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry.forEach(entry => {
            const changes = entry.changes[0];
            if (changes.field === 'messages') {
                const messages = changes.value.messages;
                if (messages) {
                    messages.forEach(message => {
                        const telefono = message.from;
                        const texto = message.text?.body;
                        
                        if (texto) {
                            const respuesta = procesarMensaje(texto, telefono);
                            enviarMensaje(telefono, respuesta);
                        }
                    });
                }
            }
        });
    }
    res.status(200).send('OK');
});

// ===============================
// ENVIAR MENSAJE WHATSAPP
// ===============================
async function enviarMensaje(telefono, mensaje) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${config.whatsapp.phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to: telefono,
            text: { body: mensaje }
        }, {
            headers: {
                'Authorization': `Bearer ${config.whatsapp.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
    }
}

// ===============================
// PANEL WEB
// ===============================
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/panel.html');
});

app.get('/api/citas', (req, res) => {
    res.json(citas);
});

app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    Object.assign(config, req.body);
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
    res.json({ success: true });
});

// ===============================
// INICIAR SERVIDOR
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Bot WhatsApp ejecutándose en puerto ${PORT}`);
    console.log(`📱 Panel: http://localhost:${PORT}`);
    console.log(`⏰ Estado: ${estaAbierto() ? 'ABIERTO' : 'CERRADO'}`);
});